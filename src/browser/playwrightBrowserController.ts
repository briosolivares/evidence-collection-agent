import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Dialog,
  type Disposable,
  type Frame,
  type Locator,
  type Page,
} from 'playwright';

import {
  performBrowserActions,
  type ActionCapableSession,
  type BlockSignals,
  type BrowserActionOutput,
  type BrowserActionRequest,
  type BrowserDialog,
  type DocumentSnapshot,
  type DownloadInfo,
  type PageActivity,
  type PageWatch,
  type ScrollAmount,
  type ScrollDirection,
  type SuccessCheck,
  type SuccessCheckOutcome,
} from './browserActions.js';
import {
  createBrowserStateStore,
  diffObservations,
  MAX_OTHER_OPEN_PAGES,
  type BrowserFrame,
  type BrowserObservation,
  type BrowserObserveRequest,
  type BrowserPage,
  type BrowserStateStore,
  type ElementRef,
  type ObservationNeed,
  type ObservationView,
  type OtherOpenPage,
} from './browserState.js';
import {
  BrowserRefNotFoundError,
  type BrowserCapturedText,
  type BrowserCommandSession,
  type BrowserController,
  type BrowserDownloadResult,
  type BrowserDownloadTarget,
  type BrowserFetchResult,
  type BrowserOperationOptions,
  type BrowserScreenshotOptions,
  type BrowserScriptSetup,
  type BrowserTaskPagePreparation,
  type BrowserTextCaptureRequest,
  type HandleDialogRequest,
  type HandleDialogResult,
} from './controller.js';
import {
  BrowserJavaScriptTimeoutError,
  type BrowserJavaScriptResult,
  type EarlyJavaScriptRequest,
} from './browserJavaScript.js';
import type {
  BrowserSessionDiagnostics,
  BrowserSessionProvider,
} from './sessionProvider.js';
import { localDownloadReader, type BrowserDownloadReader } from './downloadReader.js';
import { localUploadEncoder, type BrowserUploadEncoder } from './uploadEncoder.js';
import {
  accessKey,
  EXCLUSIVE_ACCESS,
  type BusyResourceRegistry,
} from '../tools/registry.js';
import {
  actionTargetHandle,
  locatorForRef,
  normalizeRefActionError,
  resolveRefInRecord,
  stampOutlineElements,
} from './pageElementRefs.js';
import { evaluateJavaScript } from './pageJavaScript.js';
import { captureClickDownload, captureUrlThroughChrome } from './downloadCapture.js';
import { openPlaywrightCommandSession } from './browserCommandSession.js';
import {
  ChromiumTargetControlError,
  createChromiumTargetControl,
  type ChromiumPageTargetRef,
  type ChromiumTargetControl,
} from './chromiumTargetControl.js';
import {
  assertLoopbackCdpUrl,
  CDP_LOOPBACK_HOST,
  prepareBrowserScriptTarget,
  reconcileAfterBrowserScript,
} from './browserScriptSetup.js';

const SCROLL_SETTLE_MS = 50;

/** The browser-visible property/value namespace is deliberately generic and
 * versioned. The caller's durable run id is hashed before it crosses into a
 * page, so neither page content nor a driver error can disclose a local run
 * path/id. Exact descriptor/value equality is the only ownership test. */
const RUN_PAGE_OWNERSHIP_PROPERTY = '__sherlock_run_page_owner_v1__';
const RUN_PAGE_OWNERSHIP_MARKER_PREFIX = '__sherlock_run_page_owner_v1__:';
const RUN_PAGE_TARGET_SENTINEL_PREFIX = '__sherlock_run_target_v1__:';
const MAX_RUN_PAGE_OWNERSHIP_ID_BYTES = 4_096;
const MAX_RAW_TARGET_URL_BYTES = 16_384;
const RUN_PAGE_OWNERSHIP_EVALUATION_TIMEOUT_MS = 5_000;
const MAX_RUN_PAGE_OWNERSHIP_RECOVERY_PASSES = 10;
const MAX_RUN_PAGE_OWNERSHIP_CLEANUP_PASSES = 10;
const RUN_PAGE_OWNERSHIP_CLEAN_PASSES = 2;
const TARGET_CREATION_NAVIGATION_TIMEOUT_MS = 5_000;
const BROWSER_PREPARATION_CONTAINMENT_TIMEOUT_MS = 5_000;

// --- Browser-script CDP endpoint (see launchPersistentChrome, prepareForBrowserScript). ---
/** Chrome writes this file into the user-data-dir asynchronously after
 * launch, once `--remote-debugging-port=0` gave it an ephemeral port to
 * bind. First line: the port. Second line: the browser's CDP websocket
 * path (unused here — the HTTP origin alone is a valid endpoint for
 * `chromium.connectOverCDP`). */
const DEVTOOLS_ACTIVE_PORT_FILENAME = 'DevToolsActivePort';
/** How often to re-check for the file while it has not appeared yet. */
const DEVTOOLS_ACTIVE_PORT_POLL_INTERVAL_MS = 25;
/** Bounded wait for the file to appear. Chrome writes it well under this in
 * practice; a launch that never produces it must fail loudly rather than
 * hang a session indefinitely on a CDP endpoint that will never exist. */
const DEVTOOLS_ACTIVE_PORT_DEADLINE_MS = 5_000;

// --- T9 observation bounds (all finite literals). ---
/** Per-view content bound so an evicted-baseline "full snapshot" stays
 * bounded even before the tool pipeline's byte cap. */
const MAX_VIEW_CONTENT_CHARS = 60_000;
// --- T10 action bounds (all finite literals). ---
/** Per-element-action deadline. Far below Playwright's 30s default: a
 * sequence of eight actions must not be able to hold a turn for minutes,
 * and an element that is not actionable within five seconds is better
 * reported than waited on. Exported for {@link actionTargetHandle} in
 * pageElementRefs.ts, the only other place it is used. */
export const ACTION_TIMEOUT_MS = 5_000;
/** Deadline for a `navigate` action inside a sequence. Longer than an
 * element action because a real page load legitimately takes seconds. */
const ACTION_NAVIGATION_TIMEOUT_MS = 15_000;
/** How often success checks are re-evaluated while waiting. */
const CHECK_POLL_INTERVAL_MS = 50;
/** Slack added to the in-page quiescence budget before the Node-side race
 * gives up, so the page's own answer wins whenever it can produce one. */
const QUIESCENCE_OVERHEAD_MS = 500;
/** Page text collected for blocked classification. Bounded: the classifier
 * looks for short distinctive phrases, never the whole document. */
const MAX_BLOCK_TEXT_CHARS = 20_000;
/** Frame URLs inspected for CAPTCHA/challenge widgets. */
const MAX_BLOCK_FRAME_URLS = 20;
/** Downloads remembered per page. Oldest are dropped: a sequence reports
 * the downloads *it* started, and unbounded growth would be a leak. */
const MAX_TRACKED_DOWNLOADS_PER_PAGE = 20;

/** Runtime tracking for one page: its stable id plus per-frame records.
 * Exported so pageElementRefs.ts and downloadCapture.ts can type the record
 * they are handed explicitly, without reaching into controller state. */
export interface PageRecord {
  pageId: string;
  page: Page;
  /** Keyed by the live Playwright Frame — Playwright reuses the same Frame
   * object across navigations, so the key survives exactly as long as the
   * frame's identity should. */
  frames: Map<Frame, FrameRecord>;
  /** Main-frame document replacements seen so far. Monotonic; a
   * {@link PageWatch} reads the delta rather than the absolute value. */
  navigationCount: number;
  /** Downloads this page started, oldest first, bounded — old entries are
   * evicted from the front once the array exceeds
   * {@link MAX_TRACKED_DOWNLOADS_PER_PAGE}. */
  downloads: DownloadInfo[];
  /** Every download this page has EVER started, monotonic and never
   * decremented by eviction — unlike `downloads.length`, this is a stable
   * count a {@link PageWatch} can diff against even after eviction has
   * shifted `downloads`' indices out from under a remembered offset. */
  totalDownloadsEver: number;
  /** The most recent main-frame navigation response. Kept with its URL
   * because Playwright emits `response` before `framenavigated`, so the
   * document id at capture time is still the previous one; matching on the
   * URL is what makes "this status belongs to the current document" safe. */
  lastMainResponse?: { url: string; status: number; retryAfterHeader?: string };
}

/** One dialog waiting for a decision: the engine handle plus the
 * model-facing description. */
interface PendingDialogRecord {
  dialog: Dialog;
  info: BrowserDialog;
}

interface RunPageOwnershipEpoch {
  generation: number;
  marker: string | undefined;
}

/** Identity of one tracked frame; `documentId` rotates on navigation. */
interface FrameRecord {
  frameId: string;
  documentId: string;
}

/** Configuration for browser sessions backed by persistent local Chrome. */
export interface LocalChromeBrowserSessionOptions {
  /** Absolute path to the persistent Chrome profile directory. */
  profileDir: string;
  /** Whether Chrome runs without a visible window; defaults to false. */
  headless?: boolean;
  /** Chrome/Chromium binary to launch. When omitted, Playwright
   * discovers system Google Chrome via its `chrome` channel. */
  executablePath?: string;
}

/** Launch the persistent-profile Chrome exactly as agent sessions do.
 * Exported so the `login` helper opens the SAME profile with the SAME
 * binary resolution — a second launch path would reintroduce the
 * logged-into-the-wrong-profile failure the helper exists to kill. */
export async function launchPersistentChrome(
  options: LocalChromeBrowserSessionOptions,
): Promise<BrowserContext> {
  if (!isAbsolute(options.profileDir)) {
    throw new TypeError('Browser profileDir must be an absolute path.');
  }
  // Must happen BEFORE the launch: Chrome reads this preference at startup.
  pinProfileDownloadDirectory(options.profileDir);
  return chromium.launchPersistentContext(options.profileDir, {
    ...(options.executablePath !== undefined
      ? { executablePath: options.executablePath }
      : { channel: 'chrome' }),
    headless: options.headless ?? false,
    // Opens a SECOND, loopback-only CDP TCP endpoint alongside Playwright's
    // own pipe-based control channel, so a browser script can attach an
    // independent Playwright client to this exact browser via
    // `chromium.connectOverCDP` without disturbing this controller's own
    // connection. Port 0 asks Chrome for an ephemeral port; the port Chrome
    // actually chose is read back from DevToolsActivePort in the SAME
    // profile directory (see readDevToolsActivePortUrl). This is the first
    // `args` entry this codebase has ever passed to Chrome.
    args: ['--remote-debugging-port=0'],
  });
}


/**
 * Point Chrome's own download directory inside the profile.
 *
 * Chrome — not Playwright — decides where a download it handles itself lands,
 * and it reads `download.default_directory` from the profile's Preferences at
 * startup. Unset, that resolves to the OS Downloads folder, so a download the
 * run never consumes is written into the user's home directory and left there.
 * The test suite deposited one file per run that way.
 *
 * Playwright's own `downloadsPath` does not cover this: it governs downloads
 * Playwright accepts and hands back as `Download` objects, and the leaking
 * case is one Chrome writes on its own. Neither do the CDP
 * `set*DownloadBehavior` commands, which were measured and did not stop it.
 *
 * Merged rather than overwritten, and best-effort: this profile may be a real
 * logged-in one whose other preferences must survive, and a preferences file
 * this cannot parse must not stop a session from launching.
 *
 * Exported for its own test: the leak this closes was timing-dependent (the
 * producing test leaked only when run after the other 51 in its file), so the
 * merge and best-effort behavior are pinned directly rather than left to be
 * inferred from whether a full-suite run happens to stay clean.
 */
export function pinProfileDownloadDirectory(profileDir: string): void {
  try {
    const downloadDir = join(profileDir, 'downloads');
    mkdirSync(downloadDir, { recursive: true });
    const defaultDir = join(profileDir, 'Default');
    mkdirSync(defaultDir, { recursive: true });
    const prefsPath = join(defaultDir, 'Preferences');
    const existing: Record<string, unknown> = existsSync(prefsPath)
      ? (JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>)
      : {};
    const download =
      typeof existing.download === 'object' && existing.download !== null
        ? (existing.download as Record<string, unknown>)
        : {};
    writeFileSync(
      prefsPath,
      JSON.stringify({
        ...existing,
        download: { ...download, default_directory: downloadDir, prompt_for_download: false },
      }),
    );
  } catch {
    // Best effort; see the note above.
  }
}

/**
 * Read the loopback CDP HTTP endpoint Chrome opened for a profile launched
 * by {@link launchPersistentChrome}.
 *
 * Chrome writes `DevToolsActivePort` asynchronously after launch, so this
 * polls with a bounded deadline instead of reading once.
 *
 * @param profileDir - the EXACT directory passed to `launchPersistentChrome`
 *   as `profileDir` (Chrome's user-data-dir); the file is written there and
 *   nowhere else
 * @returns a loopback (`127.0.0.1`) HTTP CDP URL, e.g. `http://127.0.0.1:54213`
 * @throws Error when the file never appears within the deadline, does not
 *   contain a valid port, or (defensively) would resolve to a non-loopback
 *   host
 */
async function readDevToolsActivePortUrl(profileDir: string): Promise<string> {
  const path = join(profileDir, DEVTOOLS_ACTIVE_PORT_FILENAME);
  const deadline = Date.now() + DEVTOOLS_ACTIVE_PORT_DEADLINE_MS;
  let lastError: unknown;
  for (;;) {
    try {
      const contents = await readFile(path, 'utf8');
      const portLine = contents.split('\n')[0]?.trim();
      const port = Number(portLine);
      if (portLine === undefined || portLine === '' || !Number.isInteger(port) || port <= 0) {
        throw new Error(
          `${DEVTOOLS_ACTIVE_PORT_FILENAME} at ${path} did not contain a valid port on its ` +
            `first line: ${JSON.stringify(portLine)}`,
        );
      }
      const cdpUrl = `http://${CDP_LOOPBACK_HOST}:${port}`;
      assertLoopbackCdpUrl(cdpUrl);
      return cdpUrl;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Chrome never wrote a usable ${DEVTOOLS_ACTIVE_PORT_FILENAME} into ${profileDir} ` +
            `within ${DEVTOOLS_ACTIVE_PORT_DEADLINE_MS}ms; its CDP debugging port never became ` +
            'available. Browser scripts will be unavailable for this session. Last error: ' +
            `${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }
      await delay(DEVTOOLS_ACTIVE_PORT_POLL_INTERVAL_MS);
    }
  }
}

/** Creates persistent local Chrome sessions controlled through Playwright. */
export class LocalChromeBrowserSessionProvider implements BrowserSessionProvider {
  constructor(private readonly options: LocalChromeBrowserSessionOptions) {}

  async createSession(): Promise<BrowserController> {
    const context = await launchPersistentChrome(this.options);
    let targetControl: ChromiumTargetControl | undefined;

    try {
      const preexistingSessionPage = await prepareSessionPage(context);
      // Read from the SAME profileDir passed to launchPersistentChrome — the
      // only directory Chrome could have written DevToolsActivePort into.
      // A read failure fails the whole session loudly rather than silently
      // shipping a controller with no browser-script support: the launch
      // args above are always present, so a missing file means Chrome's CDP
      // port genuinely never came up.
      const cdpUrl = await readDevToolsActivePortUrl(this.options.profileDir);
      targetControl = await createChromiumTargetControl({
        context,
        anchorPage: preexistingSessionPage,
      });
      return new PlaywrightBrowserController({
        context,
        cdpUrl,
        preexistingSessionPage,
        targetControl,
      });
    } catch (error) {
      await targetControl?.close();
      await context.close();
      throw error;
    }
  }
}

/**
 * Everything one {@link PlaywrightBrowserController} needs that differs
 * between the runtimes hosting it.
 *
 * An options object rather than positional parameters because the list is now
 * long enough that a call site reads as a row of anonymous arguments —
 * `new PlaywrightBrowserController(ctx, undefined, url, page)` — and the two
 * newest entries (`closeSession`, `downloadReader`) are exactly the ones a
 * reader must not mix up.
 */
export interface PlaywrightBrowserControllerOptions {
  /** The Playwright context every browser operation acts on. */
  context: BrowserContext;
  stateStore?: BrowserStateStore;
  /** Loopback CDP HTTP endpoint for this session's Chrome, when launched
   * with the debugging port {@link launchPersistentChrome} opens. Absent for
   * any provider that has none to offer (a remote session, a test double) —
   * in which case the controller offers neither
   * {@link BrowserController.prepareForBrowserScript} nor
   * {@link BrowserController.refreshAfterBrowserScript}.
   *
   * MUST be loopback. A remote service's connection URL is a full
   * session-control capability and is never accepted here — see
   * `docs/browserbase-provider-plan.md` §6 for the relay design that would
   * be required to restore browser scripts on a remote provider. */
  cdpUrl?: string;
  /** One pre-existing page {@link prepareSessionPage} leaves open (the
   * profile's original tab, or a fresh replacement). Retained for callers
   * that can have only one; merged with `preexistingSessionPages`. */
  preexistingSessionPage?: Page;
  /** Pages that existed before this controller began owning task work —
   * permanently excluded from the page registry. Attached Chrome may have
   * many user-owned tabs, while managed providers normally pass only the
   * singular option above. Without this set, an external-command refresh
   * would silently adopt unrelated user pages and expose them through
   * {@link PlaywrightBrowserController.pages} and popup/task-tab fallbacks
   * report. */
  preexistingSessionPages?: readonly Page[];
  /** Context-scoped Chromium target capability used for crash-recoverable V3
   * task-page creation. Providers construct and own this capability; callers
   * never receive its raw CDP session or target ids. */
  targetControl?: ChromiumTargetControl;
  /**
   * Release the underlying browser session. Defaults to closing the
   * `context`, which is right for a locally launched persistent context: the
   * context IS the browser.
   *
   * A remote provider needs something else — disconnect the Playwright
   * `Browser` it connected over CDP, stop its keep-alive heartbeat, and
   * explicitly release the billable remote session — and `context.close()`
   * alone would do none of it. Injected rather than subclassed so
   * {@link PlaywrightBrowserController.close}'s idempotence and its
   * serialization against in-flight tab lifecycle work stay in ONE place.
   */
  closeSession?: () => Promise<void>;
  /** How a download EVENT becomes bytes; defaults to the local-file reader.
   * See downloadReader.ts. */
  downloadReader?: BrowserDownloadReader;
  /** How a confined upload path reaches the browser; defaults to handing the
   * path through, which only works when the browser shares this filesystem.
   * See uploadEncoder.ts. */
  uploadEncoder?: BrowserUploadEncoder;
  /** User-facing facts about where this session is hosted; see
   * {@link BrowserSessionDiagnostics}. Never carries a connection URL. */
  sessionDiagnostics?: BrowserSessionDiagnostics;
}

/** Playwright implementation of the engine-neutral browser controller. */
export class PlaywrightBrowserController implements BrowserController {
  private activePage: Page | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private tabLifecycle: Promise<void> = Promise.resolve();
  private readonly state: BrowserStateStore;
  /** Every page the runtime owns identity for, in tracking order. The
   * pre-existing session page and download capture pages never enter. */
  private readonly trackedPages = new Map<Page, PageRecord>();
  /** Pages for which this controller has positive run-ownership evidence.
   * This is deliberately narrower than `context.pages()`: attached Chrome
   * can gain unrelated user tabs while a task is running. Insertion order is
   * creation/claim order and is reversed by closeTaskPages(). */
  private readonly ownedPages = new Set<Page>();
  /** Target ids returned by this run's raw Target.createTarget calls but not
   * yet paired with Playwright's asynchronously surfaced Page object. */
  private readonly pendingOwnedTargetIds = new Map<string, number>();
  /** Asynchronous opener/target ownership checks started by context page
   * events. Cleanup drains this set before taking its reverse-order snapshot
   * so a just-opened popup cannot race past the run's finally block. */
  private readonly pendingPageClaims = new Set<Promise<void>>();
  /** Pages we are about to create for internal plumbing (download capture).
   * The context's 'page' event fires for them like any other page; this
   * counter lets the listener count them out instead of registering them.
   * Incremented synchronously before `context.newPage()`, decremented by
   * the listener — deterministic because the event always precedes the
   * newPage() resolution for the same page. */
  private pendingInternalPages = 0;
  /** Dialogs held open awaiting an explicit decision, keyed by dialog id.
   * Held rather than auto-dismissed: Playwright's default dismisses every
   * dialog, which silently answers "Cancel" to questions a run may need to
   * accept. The cost is that a page with an unanswered dialog runs no
   * script until {@link handleDialog} is called — which is why an action
   * sequence stops at a dialog and reports it. */
  private readonly pendingDialogs = new Map<string, PendingDialogRecord>();
  /** Command-session detachers transferred to the controller because their
   * in-flight renderer command opened a dialog. Detaching that session first
   * makes Chrome silently dismiss the dialog; retaining it until the explicit
   * decision preserves the no-automatic-answer contract. */
  private readonly deferredCommandSessionDetachers = new Map<
    string,
    Set<() => Promise<void>>
  >();
  /** Sequence-scoped watchers subscribed to page activity (navigations,
   * new pages, dialogs, downloads). */
  private readonly activityListeners = new Set<() => void>();
  private dialogSequence = 0;
  /** Stable, collision-resistant marker for the one durable run bound to this
   * controller. It is intentionally absent from every model-facing page and
   * diagnostics shape. */
  private runPageOwnershipMarker: string | undefined;
  /** Exact removable context-script handle for the current durable epoch. */
  private runPageOwnershipInitScript: Disposable | undefined;
  /** Rotates at bind and successful disarm. Async claims carry a snapshot so
   * a late callback from run A can never consult or mutate run B's state. */
  private runPageOwnershipGeneration = 0;
  /** A failed cleanup remains bound and refuses task work/rebinding. A later
   * closeTaskPages retry may finish cleanup; otherwise replace the controller. */
  private runPageOwnershipPoisoned = false;
  /** A context page event cannot reject back through EventEmitter. If durable
   * marking of a positively-owned popup fails, close it immediately and retain
   * this generic fault for the next explicit controller boundary. */
  private runPageOwnershipFailure = false;
  /** Set via {@link setBusyRegistry}; undefined until the run's toolchain
   * wires it up (see runTask.ts's buildRunToolchain), or in a test that
   * constructs this controller directly. See {@link withRendererDeadline}
   * for what it protects. */
  private busyRegistry: BusyResourceRegistry | undefined;

  /**
   * Present iff this controller was constructed with a CDP endpoint (see
   * {@link PlaywrightBrowserControllerOptions.cdpUrl}). Assigned conditionally in the
   * constructor, rather than declared as an always-present method that
   * throws, so `typeof controller.prepareForBrowserScript === 'function'`
   * — the feature-detection {@link assertBrowserScriptSupportIsPaired} and
   * a run's tool-wiring rely on — genuinely reflects whether THIS instance
   * supports browser scripts, exactly as an omitted method would on a
   * provider that never implements this pair at all.
   */
  readonly prepareForBrowserScript?: (pageId?: string) => Promise<BrowserScriptSetup>;
  /** Paired with {@link prepareForBrowserScript}; see there. */
  readonly refreshAfterBrowserScript?: () => Promise<void>;

  private readonly context: BrowserContext;
  private readonly cdpUrl: string | undefined;
  private readonly preexistingSessionPages: ReadonlySet<Page>;
  private readonly targetControl: ChromiumTargetControl | undefined;
  private readonly closeSession: () => Promise<void>;
  private readonly downloadReader: BrowserDownloadReader;
  private readonly uploadEncoder: BrowserUploadEncoder;
  readonly sessionDiagnostics: BrowserSessionDiagnostics | undefined;

  constructor(options: PlaywrightBrowserControllerOptions) {
    this.context = options.context;
    this.cdpUrl = options.cdpUrl;
    this.preexistingSessionPages = new Set([
      ...(options.preexistingSessionPages ?? []),
      ...(options.preexistingSessionPage !== undefined ? [options.preexistingSessionPage] : []),
    ]);
    this.targetControl = options.targetControl;
    this.closeSession = options.closeSession ?? (() => this.context.close());
    this.downloadReader = options.downloadReader ?? localDownloadReader;
    this.uploadEncoder = options.uploadEncoder ?? localUploadEncoder;
    this.sessionDiagnostics = options.sessionDiagnostics;
    this.state = options.stateStore ?? createBrowserStateStore();
    if (this.cdpUrl !== undefined) {
      // Re-asserted here, not only where the URL is produced: this is the
      // boundary a remote provider would have to cross to hand a remote
      // connection URL to browser scripts, and `prepareForBrowserScript`
      // hands whatever it is given to model-generated shell code.
      assertLoopbackCdpUrl(this.cdpUrl);
      this.prepareForBrowserScript = (pageId?: string) => this.doPrepareForBrowserScript(pageId);
      this.refreshAfterBrowserScript = () => this.doRefreshAfterBrowserScript();
    }
    // A context page event alone is not ownership evidence in attached mode:
    // it may be a user opening a tab concurrently. Task tabs claim themselves
    // in newTab(); this listener claims only popups of an owned page or exact
    // target ids returned by this run's Target.createTarget commands.
    this.context.on('page', (page) => {
      if (this.pendingInternalPages > 0) {
        this.pendingInternalPages -= 1;
        return;
      }
      const epoch = this.captureRunPageOwnershipEpoch();
      const claim = this.claimPageFromCreationEvent(page, epoch).catch(() => {
        if (this.isCurrentRunPageOwnershipEpoch(epoch)) {
          this.runPageOwnershipFailure = true;
        }
      });
      this.pendingPageClaims.add(claim);
      void claim.finally(() => this.pendingPageClaims.delete(claim));
    });
  }

  setBusyRegistry(registry: BusyResourceRegistry): void {
    this.busyRegistry = registry;
  }

  newTab(options: BrowserOperationOptions = {}): Promise<void> {
    this.requirePreparationBusyRegistry(options.signal);
    return this.runTabLifecycleWithContainment(async (holdForContainment) => {
      this.requireOpenContext();
      this.requireHealthyRunPageOwnership();
      options.signal?.throwIfAborted();
      this.requireNoActiveTaskPage();

      const pagePromise = this.context.newPage();
      const page = await raceBrowserPreparationStep(
        pagePromise,
        options.signal,
        () => {
          holdForContainment(
            pagePromise
              .then(
                (createdPage) => this.containAbortedTaskPage(createdPage),
                () => undefined,
              )
              .then(() => this.drainPendingPageClaims()),
          );
        },
      );
      const claim = this.claimDurablyOwnedPage(page);
      const record = await raceBrowserPreparationStep(
        claim,
        options.signal,
        () => {
          holdForContainment(
            Promise.allSettled([
              claim,
              this.containAbortedTaskPage(page),
            ]).then(() => this.drainPendingPageClaims()),
          );
        },
      );
      this.activePage = record.page;
    });
  }

  closeTab(): Promise<void> {
    return this.serializeTabLifecycle(async () => {
      const page = this.activePage;
      this.activePage = undefined;
      if (page === undefined || page.isClosed()) {
        return;
      }

      await page.close();
    });
  }

  async goto(
    url: string,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    this.requirePreparationBusyRegistry(options.signal);
    assertHttpUrl(url);
    options.signal?.throwIfAborted();
    const page = this.requirePage();
    await raceBrowserPreparationStep(
      page.goto(url, { waitUntil: 'load' }),
      options.signal,
      () => this.containAbortedTaskPage(page),
    );
  }

  async outline(): Promise<string> {
    const page = this.requirePage();
    return this.withRendererDeadline(
      () => page.ariaSnapshot({ mode: 'ai' }),
      RENDERER_READ_TIMEOUT_MS,
    );
  }

  async screenshot(
    options: BrowserScreenshotOptions = {},
  ): Promise<Uint8Array> {
    const bytes = await this.pageFor(options.pageId).screenshot({
      fullPage: options.fullPage ?? false,
      type: 'png',
    });
    return new Uint8Array(bytes);
  }

  async fetch(url: string): Promise<BrowserFetchResult> {
    this.requireOpenContext();
    assertHttpUrl(url);
    const response = await this.context.request.get(url);

    try {
      return {
        status: response.status(),
        headers: response.headers(),
        bytes: new Uint8Array(await response.body()),
      };
    } finally {
      await response.dispose();
    }
  }

  async download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult> {
    this.requireOpenContext();
    const page = this.pageFor(target.pageId);

    if ('url' in target) {
      assertHttpUrl(target.url);
      return this.captureUrlThroughChrome(target.url, page);
    }

    const locator = await locatorForRef(page, target.ref);
    let href: string | null;
    try {
      href = await locator.evaluate((element) => {
        const value = element.getAttribute('href');
        return value === null ? null : new URL(value, element.ownerDocument.baseURI).href;
      });
    } catch (error) {
      throw await normalizeRefActionError(locator, target.ref, error);
    }

    if (href !== null && isHttpUrl(href)) {
      return this.captureUrlThroughChrome(href, page);
    }

    return captureClickDownload(locator, target.ref, page, this.downloadReader);
  }

  /** Capture a download reached by navigating a throwaway page straight to
   * `url`; see {@link captureUrlThroughChrome} in downloadCapture.ts for the
   * mechanics, and its doc for why the `pendingInternalPages` counter is
   * threaded through as two explicit callbacks rather than that module
   * reaching into this controller's state directly. */
  private captureUrlThroughChrome(url: string, referringPage: Page): Promise<BrowserDownloadResult> {
    return captureUrlThroughChrome(
      this.context,
      url,
      referringPage,
      () => {
        this.pendingInternalPages += 1;
      },
      () => {
        this.pendingInternalPages = Math.max(0, this.pendingInternalPages - 1);
      },
      this.downloadReader,
    );
  }

  currentUrl(pageId?: string): string {
    return this.pageFor(pageId).url();
  }

  async title(pageId?: string): Promise<string> {
    const page = this.pageFor(pageId);
    return this.withRendererDeadline(() => page.title(), RENDERER_READ_TIMEOUT_MS, undefined, pageId);
  }

  async pages(): Promise<BrowserPage[]> {
    this.requireOpenContext();
    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();

    const liveRecords = [...this.trackedPages.values()].filter(
      (record) => !record.page.isClosed(),
    );
    const blockedPageIds = new Set(
      [...this.pendingDialogs.values()].map((pending) => pending.info.pageId),
    );
    return Promise.all(
      liveRecords.map((record) =>
        blockedPageIds.has(record.pageId)
          ? this.describePageIdentity(record)
          : this.describePage(record),
      ),
    );
  }

  async observe(request: BrowserObserveRequest = {}): Promise<BrowserObservation> {
    this.requireOpenContext();
    const baselineId = request.basedOnObservationId;
    if (baselineId !== undefined && (!Number.isSafeInteger(baselineId) || baselineId < 1)) {
      throw new TypeError(
        `basedOnObservationId must be a positive integer: ${String(baselineId)}`,
      );
    }
    const needs = normalizeNeeds(request.need);
    const record =
      request.pageId !== undefined
        ? this.requireTrackedPage(request.pageId)
        : this.registerPage(this.requirePage());
    const page = record.page;
    // Bind this observation to the document identity at snapshot time; if a
    // navigation races mid-observe, the produced refs correctly die with
    // the document they were seen in.
    const mainFrameRecord = this.ensureFrameRecord(record, page.mainFrame());
    const documentId = mainFrameRecord.documentId;
    const url = page.url();

    let elements: ElementRef[] = [];
    const views: ObservationView[] = [];
    for (const need of needs) {
      if (need === 'interactive') {
        const outline = await this.withRendererDeadline(
          () => page.ariaSnapshot({ mode: 'ai' }),
          RENDERER_READ_TIMEOUT_MS,
          undefined,
          request.pageId,
        );
        elements = await stampOutlineElements(
          record,
          mainFrameRecord.frameId,
          documentId,
          outline,
          () => this.state.createElementId(),
        );
        views.push(makeBoundedView('interactive', outline));
      } else {
        // Exact rendered text (innerText respects visibility and layout),
        // for quotation-grade reads the outline normalizes away.
        const text = await this.withRendererDeadline(
          () => page.evaluate(() => document.body?.innerText ?? ''),
          RENDERER_READ_TIMEOUT_MS,
          undefined,
          request.pageId,
        );
        views.push(makeBoundedView('text', text));
      }
    }

    // Look the baseline up BEFORE recording, so diffing against the
    // immediately preceding observation works even at cache capacity.
    const baseline =
      baselineId !== undefined
        ? this.state.getObservation(record.pageId, baselineId)
        : undefined;
    this.state.recordObservation(record.pageId, { documentId, url, elements });
    const changes = diffObservations(baseline, { documentId, url, elements });
    const otherOpenPages = await this.describeOtherOpenPages(record);
    return {
      page: await this.describePage(record),
      views,
      elements,
      changes,
      ...(otherOpenPages.length > 0 ? { otherOpenPages } : {}),
    };
  }

  /** Other live tracked pages besides `record`, for the sibling-page
   * listing an observation carries — see {@link BrowserObservation.otherOpenPages}.
   * Bounded by {@link MAX_OTHER_OPEN_PAGES} and empty (never populated on the
   * result) when this is the only live page. */
  private async describeOtherOpenPages(record: PageRecord): Promise<OtherOpenPage[]> {
    const others = [...this.trackedPages.values()].filter(
      (candidate) => candidate !== record && !candidate.page.isClosed(),
    );
    if (others.length === 0) return [];
    return Promise.all(
      others.slice(0, MAX_OTHER_OPEN_PAGES).map(async (candidate) => {
        const described = await this.describePage(candidate);
        return { pageId: described.pageId, url: described.url, title: described.title };
      }),
    );
  }

  /**
   * Capture exact rendered text for evidence (T11).
   *
   * Deliberately NOT built on `observe`: the text view is bounded, and the
   * interactive outline is normalized — a capture must be quotable byte for
   * byte later. Records no observation and issues no refs, so capturing
   * cannot invalidate a ref the caller is holding.
   */
  async captureText(request: BrowserTextCaptureRequest = {}): Promise<BrowserCapturedText> {
    this.requireOpenContext();
    const record =
      request.pageId !== undefined
        ? this.requireTrackedPage(request.pageId)
        : this.registerPage(this.requirePage());
    const page = record.page;
    const observationId = this.state.latestObservationId(record.pageId);
    // Title mid-navigation can fail; an empty title beats failing a capture
    // whose text read fine (describePage takes the same view).
    const title = await this.withRendererDeadline(
      () => page.title(),
      RENDERER_READ_TIMEOUT_MS,
      '',
      request.pageId,
    ).catch(() => '');

    if (request.elementId === undefined) {
      const documentId = this.ensureFrameRecord(record, page.mainFrame()).documentId;
      // The page's own rendered text, not observe's view: innerText respects
      // visibility and layout, and nothing here truncates it.
      const text = await this.withRendererDeadline(
        () => page.evaluate(() => document.body?.innerText ?? ''),
        RENDERER_READ_TIMEOUT_MS,
        undefined,
        request.pageId,
      );
      return {
        text,
        url: page.url(),
        title,
        pageId: record.pageId,
        documentId,
        ...(observationId > 0 ? { observationId } : {}),
        locator: 'body',
      };
    }

    const ref = this.state.findObservedElement(record.pageId, request.elementId);
    if (ref === undefined) throw new BrowserRefNotFoundError(request.elementId);
    // resolveElementRef rejects a ref whose document was replaced, so a
    // capture can never quote text from a document that is already gone.
    const locator = await this.resolveElementRef(ref);
    const text = await locator.innerText();
    return {
      text,
      url: page.url(),
      title,
      pageId: record.pageId,
      // The ref's own document, which for a subframe element is the frame's
      // rather than the page's — that is what rendered the text.
      documentId: ref.documentId,
      ...(observationId > 0 ? { observationId } : {}),
      locator: ref.stableLocator ?? `${ref.role}[name=${JSON.stringify(ref.name)}]`,
    };
  }

  async openCommandSession(pageId?: string): Promise<BrowserCommandSession> {
    this.requireOpenContext();
    this.requireHealthyRunPageOwnership();
    // Resolve controller identity exactly once before attachment. newTab()
    // already registers the selected page; registerPage is idempotent so this
    // remains safe for any later lifecycle path that restores selection.
    const record =
      pageId === undefined
        ? this.registerPage(this.requirePage())
        : this.requireTrackedPage(pageId);
    const epoch = this.captureRunPageOwnershipEpoch();
    return openPlaywrightCommandSession(
      this.context,
      record.page,
      record.pageId,
      {
        ...(epoch.marker === undefined
          ? {
              onTargetCreated: (targetId: string) =>
                this.claimRawCreatedTarget(targetId, epoch),
            }
          : {
              createTargetCommand: (params: Record<string, unknown>) =>
                this.createRawRunTarget(params, epoch),
            }),
        handleDialogCommand: (params) =>
          this.handleRawDialogCommand(record.pageId, params),
        release: (detach) =>
          this.releaseCommandSession(record.pageId, detach),
      },
    );
  }

  private createRawRunTarget(
    params: Record<string, unknown>,
    epoch: RunPageOwnershipEpoch,
  ): Promise<unknown> {
    const requestedUrl = rawTargetCreationUrl(params);
    const targetControl = this.requireTargetControl();
    return this.runTabLifecycleWithContainment(async (holdForContainment) => {
      this.requireOpenContext();
      this.requireHealthyRunPageOwnership();
      if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
        throw new Error(
          'The browser command session belongs to an ended task-page ownership epoch.',
        );
      }
      const record = await this.createDurablyOwnedTargetPage(
        targetControl,
        epoch,
        undefined,
        holdForContainment,
      );
      try {
        await record.page.goto(requestedUrl, {
          waitUntil: 'commit',
          timeout: TARGET_CREATION_NAVIGATION_TIMEOUT_MS,
        });
        const targetId = await withRunPageOwnershipEvaluationDeadline(
          this.targetIdForPage(record.page),
        );
        if (targetId === undefined) {
          throw new Error('Could not resolve the created browser target identity.');
        }
        return { targetId };
      } catch {
        await this.containAbortedTaskPage(record.page);
        throw new Error('Could not finish creating the requested browser target.');
      }
    });
  }

  /**
   * Execute a receipted action sequence against one page and document.
   *
   * @param request - see {@link BrowserController.browserAction}
   * @returns the sequence's receipts, stop information, settle/check
   *   outcomes, and resulting page. Rejects only when the request cannot be
   *   aimed at a live page.
   */
  browserAction(request: BrowserActionRequest): Promise<BrowserActionOutput> {
    this.requireOpenContext();
    return performBrowserActions(this.actionSession(), request);
  }

  /**
   * Answer one pending JavaScript dialog.
   *
   * @param request - see {@link BrowserController.handleDialog}
   * @returns the decision, the page afterwards when it survived, and the
   *   dialogs still pending
   * @throws Error when no pending dialog has that id (already answered, or
   *   its page closed)
   */
  async handleDialog(request: HandleDialogRequest): Promise<HandleDialogResult> {
    this.requireOpenContext();
    const pending = this.pendingDialogs.get(request.dialogId);
    if (pending === undefined) {
      throw new Error(
        `No browser dialog is pending with id ${request.dialogId}. It was already ` +
          `answered, or its page closed. Pending dialogs: ` +
          `${[...this.pendingDialogs.keys()].join(', ') || '(none)'}.`,
      );
    }
    // Removed before answering: a driver-level failure must not leave a
    // dialog that can be "answered" twice, and a second call should report
    // the unknown-id error rather than rejecting inside Playwright.
    this.pendingDialogs.delete(request.dialogId);

    try {
      if (request.action === 'accept') {
        await pending.dialog.accept(request.promptText);
      } else {
        await pending.dialog.dismiss();
      }
    } finally {
      // A timed-out browser program may have transferred its blocked CDP
      // session to the controller. The explicit decision unblocks that
      // original command; only now is it safe to detach without silently
      // choosing a dialog outcome.
      await this.detachDeferredCommandSessions(pending.info.pageId);
    }
    this.signalActivity();

    const record = this.recordByPageId(pending.info.pageId);
    const stillPending = [...this.pendingDialogs.values()].map((entry) => entry.info);
    return {
      dialogId: request.dialogId,
      handled: request.action === 'accept' ? 'accepted' : 'dismissed',
      // The page can be gone (accepting a beforeunload) — report the
      // decision anyway rather than failing after it took effect.
      ...(record !== undefined && !record.page.isClosed()
        ? { page: await this.describePage(record) }
        : {}),
      pendingDialogs: stillPending,
    };
  }

  /**
   * Resolve an {@link ElementRef} to an actionable locator.
   *
   * Locates the ref's page record in the registry — the one piece of this
   * that genuinely needs controller state — then delegates the resolution
   * ladder (exact-node marker, then a unique role/name fallback) to
   * {@link resolveRefInRecord} in pageElementRefs.ts.
   *
   * @param ref - an element ref from a prior observation
   * @returns a locator matching exactly one element
   * @throws BrowserRefNotFoundError when the ref's page/frame is gone, its
   *   document was replaced (navigation invalidates prior-document refs),
   *   or the target can no longer be resolved uniquely
   */
  async resolveElementRef(ref: ElementRef): Promise<Locator> {
    this.requireOpenContext();
    const record = this.recordByPageId(ref.pageId);
    if (record === undefined || record.page.isClosed()) {
      throw new BrowserRefNotFoundError(ref.id);
    }
    return resolveRefInRecord(record, ref);
  }

  /**
   * Evaluate a snippet in a page's top document (T6).
   *
   * The page is resolved ONCE, up front — the requested `pageId`, or the
   * selected page when omitted — so a navigation mid-call cannot move
   * execution to a different document than the one whose URL and token are
   * reported. Console output is captured for the duration of the call only.
   *
   * The timeout is a Node-side race, NOT a Playwright option: `page.evaluate`
   * accepts no timeout, and a snippet spinning in a tight loop cannot be
   * interrupted from outside the renderer at all. So exceeding the deadline is
   * TERMINAL — it rejects with BrowserJavaScriptTimeoutError while the snippet
   * keeps running, and the caller must call replaceUnresponsivePage. There is
   * no partial result to salvage, and retrying into the same page would hang
   * again.
   *
   * The abandoned evaluation is deliberately left unawaited with its rejection
   * swallowed: it belongs to a page that is about to be discarded, and letting
   * it surface later would crash an unrelated turn.
   */
  async executeJavaScript(request: EarlyJavaScriptRequest): Promise<BrowserJavaScriptResult> {
    // Resolve and LOCK the target page up front: everything downstream reports
    // the URL and document token of the page it actually ran in, so a
    // concurrent change must not be able to move the target mid-call.
    const page = this.pageFor(request.pageId);
    return evaluateJavaScript(
      page,
      request,
      // Passed as a bound closure rather than `this`, so the module never
      // reaches into the busy registry an abandoned renderer read registers
      // against — see withRendererDeadline.
      <T>(read: () => Promise<T>, timeoutMs: number, fallback?: T, pageId?: string) =>
        this.withRendererDeadline(read, timeoutMs, fallback, pageId),
      RENDERER_READ_TIMEOUT_MS,
    );
  }

  /**
   * Await one evaluation against the Node-side deadline.
   *
   * Extracted so the expression/statement attempts share exactly one timeout
   * implementation — see executeJavaScript's note on why the deadline is
   * terminal and the losing evaluation is abandoned unawaited.
   */
  private async raceEvaluation(
    page: { evaluate(source: string): Promise<unknown> },
    source: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const evaluation = page.evaluate(source);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BrowserJavaScriptTimeoutError(timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([evaluation, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // The losing evaluation may still be spinning in a page that is about
      // to be replaced; ignore its eventual outcome so it cannot surface as
      // an unhandled rejection in a later turn.
      void evaluation.catch(() => undefined);
    }
  }

  /**
   * Discard a page whose JavaScript could not be terminated, and select a
   * replacement (T6).
   *
   * Serialized through the same tab-lifecycle chain as newTab/closeTab, so a
   * replacement cannot interleave with another lifecycle operation. The old
   * page is force-closed rather than awaited politely: its event loop is the
   * thing that is untrustworthy.
   */
  async replaceUnresponsivePage(): Promise<void> {
    await this.runTabLifecycleWithContainment(async (holdForContainment) => {
      const doomed = this.activePage;
      this.activePage = undefined;
      if (doomed !== undefined) {
        await this.containAbortedTaskPage(doomed);
        if (!doomed.isClosed()) {
          throw new Error(
            'The unresponsive browser page could not be contained before replacement.',
          );
        }
      }
      this.requireOpenContext();
      this.requireHealthyRunPageOwnership();
      const epoch = this.captureRunPageOwnershipEpoch();
      const record =
        epoch.marker === undefined
          ? await this.claimDurablyOwnedPage(await this.context.newPage(), epoch)
          : await this.createDurablyOwnedTargetPage(
              this.requireTargetControl(),
              epoch,
              undefined,
              holdForContainment,
            );
      this.activePage = record.page;
    });
  }

  /**
   * Implementation behind the conditionally-assigned `prepareForBrowserScript`
   * field (see the constructor) — reachable only when this controller was
   * given a CDP endpoint. Resolves the target page and guards on the CDP
   * endpoint's presence; the CDP mechanics themselves live in
   * {@link prepareBrowserScriptTarget} (browserScriptSetup.ts).
   */
  private async doPrepareForBrowserScript(pageId?: string): Promise<BrowserScriptSetup> {
    this.requireOpenContext();
    if (this.cdpUrl === undefined) {
      // Unreachable through the public field — it is only assigned when
      // cdpUrl is defined — kept as a direct guard so this method can never
      // silently return a BrowserScriptSetup with a missing cdpUrl if it is
      // ever called another way (e.g. a future internal caller).
      throw new Error('This browser session has no CDP endpoint configured.');
    }
    const page = this.pageFor(pageId);
    return prepareBrowserScriptTarget(this.context, page, this.cdpUrl);
  }

  /**
   * Implementation behind the conditionally-assigned `refreshAfterBrowserScript`
   * field; see {@link doPrepareForBrowserScript} for why it is reachable only
   * that way. The reconciliation mechanics (rescan, invalidate, reselect —
   * four steps, all documented there) live in
   * {@link reconcileAfterBrowserScript} (browserScriptSetup.ts); this method
   * only enforces the controller's own open/closed contract before handing
   * off its private collaborators as explicit closures.
   */
  async refreshAfterExternalCommands(): Promise<void> {
    this.requireOpenContext();
    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();
    await this.reconcileExternalPages(true);
    const epoch = this.captureRunPageOwnershipEpoch();
    if (this.pendingTargetCount(epoch) > 0) {
      throw new Error(
        'One or more exact task targets were not present in the complete browser page inventory.',
      );
    }
  }

  listPendingDialogs(): readonly BrowserDialog[] {
    return [...this.pendingDialogs.values()].map((pending) => ({ ...pending.info }));
  }

  initializeRunPageOwnership(
    ownershipId: string,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    if (options.signal !== undefined && this.busyRegistry === undefined) {
      return Promise.reject(
        new Error(
          'Cancellation-safe durable run ownership requires a shared busy-resource registry.',
        ),
      );
    }
    // The caller may stop waiting at the run deadline, but the lifecycle
    // queue remains chained to the real provider effect. closeTaskPages()
    // therefore cannot overlap a late stale-page close, context script
    // install, or marker mutation. The shared exclusive fence additionally
    // keeps coordinator terminalization outside this queue until the effect
    // has settled.
    const initialization = this.tabLifecycle.then(() => {
      options.signal?.throwIfAborted();
      return this.initializeRunPageOwnershipUnserialized(ownershipId);
    });
    this.tabLifecycle = initialization.then(
      () => undefined,
      () => undefined,
    );
    return raceBrowserPreparationStep(
      initialization,
      options.signal,
      () => {
        this.busyRegistry?.markAbandoned(EXCLUSIVE_ACCESS, initialization);
      },
    );
  }

  private async initializeRunPageOwnershipUnserialized(
    ownershipId: string,
  ): Promise<void> {
    this.requireOpenContext();
    const marker = runPageOwnershipMarker(ownershipId);
    if (this.runPageOwnershipMarker !== undefined) {
      if (this.runPageOwnershipMarker !== marker) {
        throw new Error(
          'This browser controller is already bound to a different durable run.',
        );
      }
      if (this.runPageOwnershipPoisoned) {
        throw new Error(
          'This browser controller remains bound after failed task-page cleanup; ' +
            'retry cleanup or replace the controller.',
        );
      }
      return;
    }
    if (
      this.runPageOwnershipInitScript !== undefined ||
      this.ownedPages.size > 0 ||
      this.activePage !== undefined ||
      this.pendingOwnedTargetIds.size > 0 ||
      this.pendingPageClaims.size > 0
    ) {
      throw new Error(
        'Durable run page ownership must be initialized before opening a task page.',
      );
    }

    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();

    if (this.targetControl !== undefined) {
      await this.recoverRunTargetSentinels(marker);
    }

    // A stale opener can create a popup just after the first snapshot. Close
    // exact matches, then rescan until one complete pass observes none. The
    // opener disappears in the first matching pass, so this converges for a
    // finite page graph; the cap turns a hostile/non-converging browser into
    // a loud failure rather than an infinite startup loop.
    for (let pass = 0; ; pass += 1) {
      let pages: Page[];
      try {
        pages = this.context.pages();
      } catch {
        throw new Error(
          'Could not enumerate browser pages while recovering durable run ownership; ' +
            'ownership was not armed.',
        );
      }

      // Inspect this complete snapshot before closing anything from it. An
      // unreadable page is uncertain, never evidence: aborting the pass is
      // the only way to guarantee an unrelated user tab is not acted on.
      const stalePages: Page[] = [];
      try {
        for (const page of pages) {
          if (!page.isClosed() && (await pageHasRunOwnershipMarker(page, marker))) {
            stalePages.push(page);
          }
        }
      } catch {
        throw new Error(
          'Could not inspect every browser page while recovering durable run ownership; ' +
            'no page from the uncertain snapshot was intentionally closed.',
        );
      }
      if (stalePages.length === 0) break;

      let closeFailures = 0;
      for (const page of stalePages.reverse()) {
        if (page.isClosed()) continue;
        try {
          await page.close({ runBeforeUnload: false });
          if (!page.isClosed()) closeFailures += 1;
        } catch {
          closeFailures += 1;
        }
      }
      if (closeFailures > 0) {
        throw new Error(
          `Could not close ${closeFailures} stale task page(s) while recovering durable ` +
            'run ownership.',
        );
      }
      if (pass + 1 >= MAX_RUN_PAGE_OWNERSHIP_RECOVERY_PASSES) {
        throw new Error(
          'Durable run page ownership recovery did not converge after its bounded scans.',
        );
      }
    }

    let initScript: Disposable;
    try {
      // Runs before site JavaScript in every new document. A popup inherits
      // ownership only from an exact marked opener; unrelated new tabs stay
      // untouched. Per-page scripts installed by claimDurablyOwnedPage are
      // the unconditional navigation-persistence layer after positive claim.
      initScript = await this.context.addInitScript(
        ({ property, marker }: { property: string; marker: string }) => {
          const own = Object.getOwnPropertyDescriptor(window, property);
          if (
            own?.value === marker &&
            own.enumerable === false &&
            own.configurable === false &&
            own.writable === false
          ) {
            return;
          }
          try {
            const opener = window.opener as (Window & Record<string, unknown>) | null;
            if (opener?.[property] !== marker) return;
            Object.defineProperty(window, property, {
              value: marker,
              enumerable: false,
              configurable: false,
              writable: false,
            });
          } catch {
            // A cross-origin or explicitly severed opener is not evidence.
          }
        },
        { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker },
      );
    } catch {
      throw new Error(
        'Could not arm durable page ownership for this browser session.',
      );
    }

    this.runPageOwnershipGeneration += 1;
    this.runPageOwnershipMarker = marker;
    this.runPageOwnershipInitScript = initScript;
    this.runPageOwnershipPoisoned = false;
  }

  private async recoverRunTargetSentinels(marker: string): Promise<void> {
    const targetControl = this.requireTargetControl();
    const sentinelUrl = runPageTargetSentinel(marker);
    let cleanPasses = 0;

    for (
      let pass = 0;
      pass < MAX_RUN_PAGE_OWNERSHIP_RECOVERY_PASSES;
      pass += 1
    ) {
      let targets: Awaited<ReturnType<ChromiumTargetControl['listPageTargets']>>;
      try {
        // listPageTargets validates the complete context-scoped inventory
        // before returning any refs. No close begins from a partial snapshot.
        targets = await targetControl.listPageTargets();
      } catch {
        throw new Error(
          'Could not inventory browser targets while recovering durable run ownership; ' +
            'no uncertain target was intentionally closed.',
        );
      }
      const staleTargets = targets.filter((target) => target.url === sentinelUrl);
      if (staleTargets.length === 0) {
        cleanPasses += 1;
        if (cleanPasses >= RUN_PAGE_OWNERSHIP_CLEAN_PASSES) return;
        await browserOwnershipEventTurn();
        continue;
      }

      cleanPasses = 0;
      let closeFailures = 0;
      for (const target of [...staleTargets].reverse()) {
        try {
          await targetControl.closeTarget(target.ref);
        } catch {
          closeFailures += 1;
        }
      }
      if (closeFailures > 0) {
        throw new Error(
          `Could not close ${closeFailures} stale task target(s) while recovering ` +
            'durable run ownership.',
        );
      }
      await targetControl.drainContainment();
      await browserOwnershipEventTurn();
    }

    throw new Error(
      'Durable run target recovery did not converge after its bounded scans.',
    );
  }

  async prepareTaskPage(request: BrowserTaskPagePreparation): Promise<void> {
    request.signal?.throwIfAborted();
    if (this.targetControl === undefined) {
      throw new Error(
        'Crash-recoverable task-page preparation requires provider target control.',
      );
    }
    await this.initializeRunPageOwnership(request.ownershipId, {
      signal: request.signal,
    });
    request.signal?.throwIfAborted();
    await this.openDurableTaskTarget({ signal: request.signal });
    if (request.startUrl !== undefined) {
      await this.goto(request.startUrl, { signal: request.signal });
    }
  }

  /** Open the V3 task page through an exact hashed sentinel target. A process
   * killed before the page marker is installed leaves that sentinel behind;
   * same-run recovery can therefore identify it without guessing from page
   * order or exposing the raw durable run id. */
  private openDurableTaskTarget(
    options: BrowserOperationOptions,
  ): Promise<void> {
    this.requirePreparationBusyRegistry(options.signal);
    const targetControl = this.requireTargetControl();
    return this.runTabLifecycleWithContainment(async (holdForContainment) => {
      this.requireOpenContext();
      this.requireHealthyRunPageOwnership();
      options.signal?.throwIfAborted();
      this.requireNoActiveTaskPage();
      const epoch = this.captureRunPageOwnershipEpoch();
      const record = await this.createDurablyOwnedTargetPage(
        targetControl,
        epoch,
        options.signal,
        holdForContainment,
      );
      this.activePage = record.page;
    });
  }

  private async createDurablyOwnedTargetPage(
    targetControl: ChromiumTargetControl,
    epoch: RunPageOwnershipEpoch,
    signal: AbortSignal | undefined,
    holdForContainment: (effect: Promise<unknown>) => void,
  ): Promise<PageRecord> {
    if (
      epoch.marker === undefined ||
      !this.isCurrentRunPageOwnershipEpoch(epoch)
    ) {
      throw new Error('Durable task-page ownership is not initialized.');
    }
    const sentinelUrl = runPageTargetSentinel(epoch.marker);
    let target: ChromiumPageTargetRef | undefined;
    let page: Page | undefined;
    let claimPromise: Promise<unknown> | undefined;
    let containmentStarted = false;
    const pagePromise = (async () => {
      target = await targetControl.createPageTarget(sentinelUrl, { signal });
      page = await targetControl.awaitPage(target, { signal });
      return page;
    })();
    const containOnce = (): void => {
      if (containmentStarted) return;
      containmentStarted = true;
      holdForContainment(
        this.containTargetPageCreation(
          targetControl,
          pagePromise,
          () => target,
          () => page,
          () => claimPromise,
        ),
      );
    };

    try {
      page = await raceBrowserPreparationStep(pagePromise, signal, containOnce);
    } catch (error) {
      containOnce();
      throw error;
    }

    const claim = (async () => {
      const record = await this.claimDurablyOwnedPage(page!, epoch);
      await this.stripRunTargetSentinel(page!, sentinelUrl);
      return record;
    })();
    claimPromise = claim;
    try {
      return await raceBrowserPreparationStep(claim, signal, containOnce);
    } catch (error) {
      containOnce();
      throw error;
    }
  }

  private async containTargetPageCreation(
    targetControl: ChromiumTargetControl,
    pagePromise: Promise<Page>,
    target: () => ChromiumPageTargetRef | undefined,
    page: () => Page | undefined,
    pendingClaim: () => Promise<unknown> | undefined,
  ): Promise<void> {
    // Wait for the bounded wrapper to register any late raw-create effect
    // before snapshotting drainContainment(). The underlying create itself may
    // remain pending forever, in which case that drain is intentionally the
    // exclusive busy fence that prevents terminalization/rebinding.
    await Promise.allSettled([pagePromise]);
    const effects: Promise<unknown>[] = [];
    const claim = pendingClaim();
    if (claim !== undefined) effects.push(claim);
    const createdPage = page();
    if (createdPage !== undefined) {
      effects.push(this.containAbortedTaskPage(createdPage));
    }
    const createdTarget = target();
    if (createdTarget !== undefined) {
      effects.push(targetControl.closeTarget(createdTarget).catch(() => undefined));
    }
    await Promise.allSettled(effects);
    await targetControl.drainContainment();
    await this.drainPendingPageClaims();
  }

  private async stripRunTargetSentinel(
    page: Page,
    sentinelUrl: string,
  ): Promise<void> {
    const stripped = await withRunPageOwnershipEvaluationDeadline(
      page.evaluate((expectedSentinel) => {
        if (location.href !== expectedSentinel) return false;
        history.replaceState(history.state, '', 'about:blank');
        return location.href === 'about:blank';
      }, sentinelUrl),
    );
    if (stripped !== true || page.url() !== 'about:blank') {
      throw new Error('Could not disarm the durable task-target sentinel.');
    }
  }

  closeTaskPages(): Promise<void> {
    return this.serializeTabLifecycle(() => this.closeTaskPagesUnserialized());
  }

  private async closeTaskPagesUnserialized(): Promise<void> {
    const epoch = this.captureRunPageOwnershipEpoch();
    try {
      let errors = await this.closeOwnedPagesToFixedPoint(epoch);
      if (errors.length > 0) {
        throw new Error(`Could not close every task page: ${errors.join('; ')}`);
      }

      const initScript = this.runPageOwnershipInitScript;
      if (initScript !== undefined) {
        try {
          await initScript.dispose();
          this.runPageOwnershipInitScript = undefined;
        } catch {
          throw new Error(
            'Could not remove durable task-page ownership from the browser context.',
          );
        }
      }

      // Disabling propagation is not enough by itself: a popup/target event
      // may already be queued. Prove a second fixed point with the same epoch
      // before rotating it and allowing another run to bind.
      errors = await this.closeOwnedPagesToFixedPoint(epoch);
      if (errors.length > 0) {
        throw new Error(`Could not close every task page: ${errors.join('; ')}`);
      }

      this.runPageOwnershipGeneration += 1;
      this.runPageOwnershipMarker = undefined;
      this.runPageOwnershipFailure = false;
      this.runPageOwnershipPoisoned = false;
    } catch (error) {
      if (
        epoch.marker !== undefined ||
        this.ownedPages.size > 0 ||
        this.pendingOwnedTargetIds.size > 0 ||
        this.pendingPageClaims.size > 0
      ) {
        this.runPageOwnershipPoisoned = true;
      }
      throw error;
    }
  }

  private async reconcileExternalPages(ownedOnly: boolean): Promise<void> {
    const epoch = this.captureRunPageOwnershipEpoch();
    await reconcileAfterBrowserScript({
      context: this.context,
      preexistingSessionPages: this.preexistingSessionPages,
      trackedPages: this.trackedPages,
      createDocumentId: () => this.state.createDocumentId(),
      forgetPage: (pageId) => this.state.forgetPage(pageId),
      registerPage: (page) => this.claimDurablyOwnedPage(page, epoch),
      ...(ownedOnly
        ? {
            shouldRegisterPage: (page: Page) =>
              this.hasOwnershipEvidence(page, epoch),
          }
        : {}),
      getActivePage: () => this.activePage,
      setActivePage: (page) => {
        this.activePage = page;
      },
    });
  }

  /** Establish containment synchronously, then close without awaiting a
   * potentially wedged Playwright promise. closeTaskPages() will retry every
   * positively owned page before terminal state is persisted. */
  private async containAbortedTaskPage(page: Page): Promise<void> {
    if (this.activePage === page) this.activePage = undefined;
    if (!this.preexistingSessionPages.has(page)) this.ownedPages.add(page);
    if (page.isClosed()) return;
    let closing: Promise<void>;
    try {
      closing = page.close({ runBeforeUnload: false });
    } catch {
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      settled = await Promise.race([
        closing.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            BROWSER_PREPARATION_CONTAINMENT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!settled && !page.isClosed()) {
      // The outer coordinator checks this exact exclusive fence before any
      // terminal cleanup or checkpoint. A close that never acknowledges
      // therefore leaves the active checkpoint resumable instead of racing a
      // terminal projection.
      this.busyRegistry?.markAbandoned(EXCLUSIVE_ACCESS, closing);
    }
  }

  private requirePreparationBusyRegistry(
    signal: AbortSignal | undefined,
  ): void {
    if (signal !== undefined && this.busyRegistry === undefined) {
      throw new Error(
        'Cancellation-safe browser preparation requires a shared busy-resource registry.',
      );
    }
  }

  private async doRefreshAfterBrowserScript(): Promise<void> {
    this.requireOpenContext();
    // Compatibility for the soon-to-be-retired external Playwright script
    // path: it had no command-session hook through which to report exact raw
    // target creation, so it retains its historical "adopt every new page"
    // behavior until Step 6 removes it.
    await this.reconcileExternalPages(false);
  }

  pdfPageSource(): Pick<BrowserContext, 'newPage'> {
    if (this.closed) {
      throw new Error(
        'The browser session is closed, so no page can be opened to render a PDF.',
      );
    }
    // The persistent context, handed over as a page FACTORY rather than as a
    // page. The renderer therefore opens, isolates, and closes a page it owns
    // outright — it can never reach `activePage`, so a render cannot navigate
    // the worker's own tab out from under the refs it is holding.
    //
    // Deliberately NOT wrapped in `registerPage`: a render page is an internal
    // throwaway, and tracking it would make it visible to `pages()` and
    // eligible for selection, which is exactly the confusion this avoids.
    return this.context;
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = this.serializeTabLifecycle(async () => {
      let ownershipError = false;
      try {
        await this.closeTaskPagesUnserialized();
      } catch {
        ownershipError = true;
      }
      let targetControlError = false;
      try {
        await this.targetControl?.close();
      } catch {
        targetControlError = true;
      }
      let sessionError = false;
      // Whatever the provider injected: close the local persistent context,
      // or disconnect and explicitly release a billable remote session.
      try {
        await this.closeSession();
      } catch {
        sessionError = true;
      }
      if (ownershipError || targetControlError || sessionError) {
        throw new Error(
          [
            ...(ownershipError ? ['task-page cleanup failed'] : []),
            ...(targetControlError ? ['browser target-control cleanup failed'] : []),
            ...(sessionError ? ['browser-session cleanup failed'] : []),
          ].join('; '),
        );
      }
    });
    return this.closePromise;
  }

  private requireOpenContext(): void {
    if (this.closed) {
      throw new Error('Browser session is closed.');
    }

    // `closed` records only that WE closed it. A REMOTE session also ends on
    // its own — Browserbase's session timeout — and nothing local observes
    // that. Without this check the next operation falls through to
    // requirePage(), whose "No browser task tab is active; call newTab()
    // first." reads as a recoverable state and invites a retry against a
    // browser that no longer exists. Measured: after a session timed out
    // mid-run, an agent alternated navigate/sleep for ~20 turns and would
    // have continued indefinitely (DEFAULT_MAX_TURNS is Infinity).
    //
    // Phrased so isBrowserDeathMessage() recognizes it, which routes the TUI
    // and REPL into their existing relaunch path — for a remote provider, a
    // fresh session on the persisted Context.
    //
    // `context.browser()` is null for a locally launched persistent context,
    // so this is inert for local Chrome, which has no equivalent failure.
    if (this.context.browser()?.isConnected() === false) {
      throw new Error(
        'The browser session has been disconnected; the remote session has ended and cannot be reused.',
      );
    }
  }

  /** Claim a page surfaced by Playwright only when its opener or an exact
   * raw-CDP target result proves that this task created it. Event callbacks
   * cannot propagate errors to their emitter, so a later explicit refresh is
   * still the authoritative, failing reconciliation boundary. */
  private async claimPageFromCreationEvent(
    page: Page,
    epoch: RunPageOwnershipEpoch,
  ): Promise<void> {
    if (this.closed || page.isClosed()) return;
    if (await this.hasOwnershipEvidence(page, epoch)) {
      if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        return;
      }
      await this.claimDurablyOwnedPage(page, epoch);
    }
  }

  /** Record one exact target returned by this run's Target.createTarget and
   * pair it with the corresponding Playwright page when available. */
  private async claimRawCreatedTarget(
    targetId: string,
    epoch: RunPageOwnershipEpoch,
  ): Promise<void> {
    if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
      throw new Error(
        'A raw browser target completed after its task-page ownership epoch ended.',
      );
    }
    this.pendingOwnedTargetIds.set(targetId, epoch.generation);
    for (const page of this.context.pages()) {
      if (
        page.isClosed() ||
        this.preexistingSessionPages.has(page) ||
        this.ownedPages.has(page)
      ) {
        continue;
      }
      if ((await this.targetIdForPage(page)) === targetId) {
        this.pendingOwnedTargetIds.delete(targetId);
        await this.claimDurablyOwnedPage(page, epoch);
        return;
      }
    }
  }

  /** Whether a live, non-pre-existing page belongs to this task. */
  private async hasOwnershipEvidence(
    page: Page,
    epoch: RunPageOwnershipEpoch = this.captureRunPageOwnershipEpoch(),
    strict = false,
  ): Promise<boolean> {
    if (this.ownedPages.has(page)) return true;
    if (this.preexistingSessionPages.has(page) || page.isClosed()) return false;

    try {
      const opener = await page.opener();
      if (opener !== null && this.ownedPages.has(opener)) return true;
    } catch (error) {
      if (page.isClosed()) return false;
      if (strict) throw error;
    }

    if (
      [...this.pendingOwnedTargetIds.values()].some(
        (generation) => generation === epoch.generation,
      )
    ) {
      const targetId = await this.targetIdForPage(page);
      if (
        targetId !== undefined &&
        this.pendingOwnedTargetIds.get(targetId) === epoch.generation
      ) {
        this.pendingOwnedTargetIds.delete(targetId);
        return true;
      }
      if (targetId === undefined && strict && !page.isClosed()) {
        throw new Error('Could not resolve a browser target during task-page cleanup.');
      }
    }

    // The context init script propagates the exact marker before site code.
    // This is the durable fallback for popups whose DOM opener was severed.
    const marker = epoch.marker;
    if (marker === undefined) return false;
    try {
      return await pageHasRunOwnershipMarker(page, marker);
    } catch (error) {
      if (strict && !page.isClosed()) throw error;
      return false;
    }
  }

  /** Resolve a page's target through a short-lived attached session. Failure
   * is treated as no ownership evidence here; the real command/refresh path
   * still performs its own loud liveness checks. */
  private async targetIdForPage(page: Page): Promise<string | undefined> {
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
    try {
      session = await this.context.newCDPSession(page);
      const result = await session.send('Target.getTargetInfo');
      const targetId = result.targetInfo?.targetId;
      return typeof targetId === 'string' && targetId.length > 0
        ? targetId
        : undefined;
    } catch {
      return undefined;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private registerOwnedPage(page: Page): PageRecord {
    if (this.preexistingSessionPages.has(page)) {
      throw new Error('A pre-existing user page cannot be claimed as a task page.');
    }
    this.ownedPages.add(page);
    return this.registerPage(page);
  }

  /** Mark one positively-owned page before registering or exposing it. A
   * failed mark closes the uncertain page immediately, so a process crash can
   * never leave a known-but-unmarked task page behind intentionally. */
  private async claimDurablyOwnedPage(
    page: Page,
    epoch: RunPageOwnershipEpoch = this.captureRunPageOwnershipEpoch(),
  ): Promise<PageRecord> {
    if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw new Error('Task-page ownership changed before the page could be claimed.');
    }
    try {
      await this.markDurablyOwnedPage(page, epoch.marker);
    } catch {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw new Error(
        'Could not durably mark a newly owned task page; the page was closed when possible.',
      );
    }
    if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw new Error('Task-page ownership changed while the page was being claimed.');
    }
    return this.registerOwnedPage(page);
  }

  /** Install an unconditional per-page new-document script, then mark and
   * verify the current document. `Page.addInitScript` follows this browsing
   * context across same- and cross-origin navigation. */
  private async markDurablyOwnedPage(
    page: Page,
    marker: string | undefined,
  ): Promise<void> {
    if (marker === undefined) return;
    const payload = { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker };
    await page.addInitScript(
      ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
        Object.defineProperty(window, property, {
          value: expectedMarker,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      },
      payload,
    );
    const marked = await withRunPageOwnershipEvaluationDeadline(
      page.evaluate(
        ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
          const existing = Object.getOwnPropertyDescriptor(window, property);
          if (existing === undefined) {
            Object.defineProperty(window, property, {
              value: expectedMarker,
              enumerable: false,
              configurable: false,
              writable: false,
            });
          }
          const installed = Object.getOwnPropertyDescriptor(window, property);
          return (
            installed?.value === expectedMarker &&
            installed.enumerable === false &&
            installed.configurable === false &&
            installed.writable === false
          );
        },
        payload,
      ),
    );
    if (marked !== true) {
      throw new Error('The browser did not retain its durable task-page marker.');
    }
  }

  private async drainPendingPageClaims(): Promise<void> {
    await Promise.all([...this.pendingPageClaims]);
  }

  private requireHealthyRunPageOwnership(): void {
    if (this.runPageOwnershipPoisoned) {
      throw new Error(
        'Task-page ownership cleanup previously failed; retry cleanup or replace the controller.',
      );
    }
    if (this.runPageOwnershipFailure) {
      throw new Error(
        'A positively-owned browser page could not be durably marked and was closed.',
      );
    }
  }

  private requireTargetControl(): ChromiumTargetControl {
    if (this.targetControl === undefined) {
      throw new Error(
        'Crash-recoverable browser target control is unavailable for this session.',
      );
    }
    return this.targetControl;
  }

  private async handleRawDialogCommand(
    pageId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (typeof params.accept !== 'boolean') {
      throw new TypeError('Page.handleJavaScriptDialog requires a boolean accept parameter.');
    }
    if (params.promptText !== undefined && typeof params.promptText !== 'string') {
      throw new TypeError('Page.handleJavaScriptDialog promptText must be a string.');
    }
    if (params.accept === false && params.promptText !== undefined) {
      throw new TypeError('promptText is allowed only when accepting a dialog.');
    }
    const pending = [...this.pendingDialogs.values()].find(
      (candidate) => candidate.info.pageId === pageId,
    );
    if (pending === undefined) {
      throw new Error(`No browser dialog is pending for pageId ${pageId}.`);
    }
    await this.handleDialog({
      dialogId: pending.info.dialogId,
      action: params.accept ? 'accept' : 'dismiss',
      ...(typeof params.promptText === 'string'
        ? { promptText: params.promptText }
        : {}),
    });
    return {};
  }

  private async releaseCommandSession(
    pageId: string,
    detach: () => Promise<void>,
  ): Promise<void> {
    // Let Playwright deliver a dialog event queued by the just-completed CDP
    // message before deciding whether detaching would answer it implicitly.
    await Promise.resolve();
    const blocked = [...this.pendingDialogs.values()].some(
      (pending) => pending.info.pageId === pageId,
    );
    if (!blocked) {
      await detach();
      return;
    }
    let detachers = this.deferredCommandSessionDetachers.get(pageId);
    if (detachers === undefined) {
      detachers = new Set();
      this.deferredCommandSessionDetachers.set(pageId, detachers);
    }
    detachers.add(detach);
  }

  private async detachDeferredCommandSessions(pageId: string): Promise<void> {
    const detachers = this.deferredCommandSessionDetachers.get(pageId);
    if (detachers === undefined) return;
    this.deferredCommandSessionDetachers.delete(pageId);
    await Promise.all([...detachers].map((detach) => detach()));
  }

  /** Reach a bounded two-pass fixed point before an ownership epoch may end.
   * Each pass drains already-dispatched page events, inventories every live
   * non-user page with strict ownership checks, closes exact owned pages in
   * reverse order, and yields one event-loop turn. Two consecutive no-work
   * passes prove that closing an opener did not leave a queued popup claim. */
  private async closeOwnedPagesToFixedPoint(
    epoch: RunPageOwnershipEpoch,
  ): Promise<string[]> {
    let cleanPasses = 0;
    let lastErrors: string[] = [];

    for (let pass = 0; pass < MAX_RUN_PAGE_OWNERSHIP_CLEANUP_PASSES; pass += 1) {
      const errors: string[] = [];
      let didWork =
        this.ownedPages.size > 0 ||
        this.pendingPageClaims.size > 0 ||
        this.pendingTargetCount(epoch) > 0;

      if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
        return ['task-page ownership changed during cleanup'];
      }

      try {
        await this.drainPendingPageClaims();
      } catch {
        errors.push('a pending task-page claim did not settle cleanly');
      }
      if (this.runPageOwnershipFailure) {
        errors.push('a positively-owned page could not be durably marked');
      }

      if (this.targetControl !== undefined && epoch.marker !== undefined) {
        try {
          // The target-control inventory is all-or-nothing: malformed or
          // incomplete target metadata rejects before any exact sentinel is
          // returned for mutation.
          const targets = await this.targetControl.listPageTargets();
          const sentinelUrl = runPageTargetSentinel(epoch.marker);
          const staleTargets = targets.filter(
            (target) => target.url === sentinelUrl,
          );
          if (staleTargets.length > 0) didWork = true;
          let closeFailures = 0;
          for (const target of [...staleTargets].reverse()) {
            try {
              await this.targetControl.closeTarget(target.ref);
            } catch {
              closeFailures += 1;
            }
          }
          if (closeFailures > 0) {
            errors.push(
              `${closeFailures} exact task target(s) could not be closed`,
            );
          }
        } catch (error) {
          errors.push(
            error instanceof ChromiumTargetControlError
              ? `task target inventory was incomplete during cleanup: ${error.message}`
              : 'task target inventory was incomplete during cleanup',
          );
        }
      }

      try {
        for (const page of this.context.pages()) {
          if (
            !page.isClosed() &&
            !this.preexistingSessionPages.has(page) &&
            (await this.hasOwnershipEvidence(page, epoch, true))
          ) {
            didWork = true;
            if (!this.ownedPages.has(page)) {
              await this.claimDurablyOwnedPage(page, epoch);
            }
          }
        }
        await this.drainPendingPageClaims();
      } catch {
        errors.push('live task pages could not be fully inventoried before cleanup');
      }

      this.activePage = undefined;
      for (const page of [...this.ownedPages].reverse()) {
        const pageId = this.trackedPages.get(page)?.pageId ?? '(unregistered)';
        if (!page.isClosed()) {
          didWork = true;
          try {
            await page.close({ runBeforeUnload: false });
          } catch {
            // Deliberately omit the driver error: remote Playwright errors may
            // retain a provider connection URL.
          }
        }
        if (page.isClosed()) this.ownedPages.delete(page);
        await this.detachDeferredCommandSessions(pageId);
      }
      for (const pageId of [...this.deferredCommandSessionDetachers.keys()]) {
        await this.detachDeferredCommandSessions(pageId);
      }

      await browserOwnershipEventTurn();

      if (this.ownedPages.size > 0) {
        errors.push(
          `${this.ownedPages.size} task page(s) remained live after cleanup`,
        );
      }
      const pendingTargets = this.pendingTargetCount(epoch);
      if (pendingTargets > 0) {
        errors.push(
          `${pendingTargets} exact task target(s) remained unresolved after cleanup`,
        );
      }
      if (this.pendingPageClaims.size > 0) {
        errors.push(
          `${this.pendingPageClaims.size} task page claim(s) remained pending after cleanup`,
        );
      }

      lastErrors = errors;
      if (!didWork && errors.length === 0) {
        cleanPasses += 1;
        if (cleanPasses >= RUN_PAGE_OWNERSHIP_CLEAN_PASSES) return [];
      } else {
        cleanPasses = 0;
      }
    }

    return lastErrors.length > 0
      ? lastErrors
      : ['task-page cleanup did not reach a bounded quiescent fixed point'];
  }

  private captureRunPageOwnershipEpoch(): RunPageOwnershipEpoch {
    return {
      generation: this.runPageOwnershipGeneration,
      marker: this.runPageOwnershipMarker,
    };
  }

  private isCurrentRunPageOwnershipEpoch(
    epoch: RunPageOwnershipEpoch,
  ): boolean {
    return (
      epoch.generation === this.runPageOwnershipGeneration &&
      epoch.marker === this.runPageOwnershipMarker
    );
  }

  private pendingTargetCount(epoch: RunPageOwnershipEpoch): number {
    let count = 0;
    for (const generation of this.pendingOwnedTargetIds.values()) {
      if (generation === epoch.generation) count += 1;
    }
    return count;
  }

  /** Track a page's identity: assign a stable pageId, record every current
   * frame, and follow document replacement, frame attach/detach, and close
   * through Playwright events. Idempotent — re-registering returns the
   * existing record, so the context listener and explicit callers compose. */
  private registerPage(page: Page): PageRecord {
    const existing = this.trackedPages.get(page);
    if (existing !== undefined) {
      return existing;
    }

    const record: PageRecord = {
      pageId: this.state.createPageId(),
      page,
      frames: new Map(),
      navigationCount: 0,
      downloads: [],
      totalDownloadsEver: 0,
    };
    this.trackedPages.set(page, record);
    for (const frame of page.frames()) {
      this.ensureFrameRecord(record, frame);
    }

    page.on('frameattached', (frame) => {
      this.ensureFrameRecord(record, frame);
    });
    page.on('framenavigated', (frame) => {
      const frameRecord = record.frames.get(frame);
      if (frameRecord === undefined) {
        this.ensureFrameRecord(record, frame);
        return;
      }
      // Navigation/reload replaced the frame's document; refs bound to the
      // old documentId are stale from here on. (Playwright also emits this
      // for same-document navigations — rotating there too is conservative:
      // it can only force a re-observation, never a wrong-target action.)
      frameRecord.documentId = this.state.createDocumentId();
      if (frame === page.mainFrame()) {
        record.navigationCount += 1;
        // Wake any in-flight action sequence: this is the boundary that
        // makes its remaining actions unsafe to run.
        this.signalActivity();
      }
    });
    page.on('framedetached', (frame) => {
      record.frames.delete(frame);
    });
    page.on('response', (response) => {
      // Only the response that produced the current main document matters
      // for blocked classification; subresources say nothing about the wall
      // the user hit.
      if (response.frame() !== page.mainFrame() || !response.request().isNavigationRequest()) {
        return;
      }
      const retryAfterHeader = response.headers()['retry-after'];
      record.lastMainResponse = {
        url: response.url(),
        status: response.status(),
        ...(retryAfterHeader !== undefined ? { retryAfterHeader } : {}),
      };
    });
    page.on('dialog', (dialog) => {
      const dialogId = `dialog-${++this.dialogSequence}`;
      const defaultValue = dialog.defaultValue();
      this.pendingDialogs.set(dialogId, {
        dialog,
        info: {
          dialogId,
          pageId: record.pageId,
          type: normalizeDialogType(dialog.type()),
          message: dialog.message(),
          ...(defaultValue !== '' ? { defaultValue } : {}),
        },
      });
      this.signalActivity();
    });
    page.on('download', (download) => {
      const suggestedFilename = download.suggestedFilename();
      record.downloads.push({
        pageId: record.pageId,
        sourceUrl: download.url(),
        ...(suggestedFilename !== '' ? { suggestedFilename } : {}),
      });
      record.totalDownloadsEver += 1;
      while (record.downloads.length > MAX_TRACKED_DOWNLOADS_PER_PAGE) {
        record.downloads.shift();
      }
      this.signalActivity();
    });
    page.on('close', () => {
      this.trackedPages.delete(page);
      this.ownedPages.delete(page);
      this.state.forgetPage(record.pageId);
      // A closed page's dialogs can never be answered; dropping them keeps
      // handle_dialog's "unknown dialog" error honest instead of handing
      // out ids that would reject deep inside the driver.
      for (const [dialogId, pending] of this.pendingDialogs) {
        if (pending.info.pageId === record.pageId) {
          this.pendingDialogs.delete(dialogId);
        }
      }
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      void this.detachDeferredCommandSessions(record.pageId);
      this.signalActivity();
    });

    // A newly tracked page IS the popup signal an action sequence watches
    // for; announce it after the record exists so watchers can describe it.
    this.signalActivity();
    return record;
  }

  private ensureFrameRecord(record: PageRecord, frame: Frame): FrameRecord {
    let frameRecord = record.frames.get(frame);
    if (frameRecord === undefined) {
      frameRecord = {
        frameId: this.state.createFrameId(),
        documentId: this.state.createDocumentId(),
      };
      record.frames.set(frame, frameRecord);
    }
    return frameRecord;
  }

  private recordByPageId(pageId: string): PageRecord | undefined {
    for (const record of this.trackedPages.values()) {
      if (record.pageId === pageId) {
        return record;
      }
    }
    return undefined;
  }

  private requireTrackedPage(pageId: string): PageRecord {
    const record = this.recordByPageId(pageId);
    if (record === undefined || record.page.isClosed()) {
      throw new Error(`Unknown or closed browser pageId: ${pageId}`);
    }
    return record;
  }

  /** Build the engine-neutral view of one tracked page. Never records an
   * observation — `observationId` only reports the latest number. */
  private async describePage(record: PageRecord): Promise<BrowserPage> {
    // Mid-navigation the title evaluation can fail; '' beats failing the
    // whole listing.
    return this.buildPage(
      record,
      await this.withRendererDeadline(
        () => record.page.title(),
        RENDERER_READ_TIMEOUT_MS,
        '',
      ).catch(() => ''),
    );
  }

  /** The same view without touching the renderer. Used while a dialog has
   * the page blocked: `page.title()` is a renderer read and would wait for
   * the dialog to be answered, turning a reportable state into a hang. */
  private describePageIdentity(record: PageRecord): BrowserPage {
    return this.buildPage(record, '');
  }

  private buildPage(record: PageRecord, title: string): BrowserPage {
    const page = record.page;
    const mainFrame = page.mainFrame();
    const mainRecord = this.ensureFrameRecord(record, mainFrame);
    const frames: BrowserFrame[] = [
      { frameId: mainRecord.frameId, documentId: mainRecord.documentId, url: mainFrame.url() },
    ];
    for (const [frame, frameRecord] of record.frames) {
      if (frame === mainFrame || frame.isDetached()) {
        continue;
      }
      frames.push({
        frameId: frameRecord.frameId,
        documentId: frameRecord.documentId,
        url: frame.url(),
      });
    }
    return {
      pageId: record.pageId,
      documentId: mainRecord.documentId,
      observationId: this.state.latestObservationId(record.pageId),
      url: page.url(),
      title,
      active: this.activePage === page && !page.isClosed(),
      frames,
    };
  }

  /** Wake every sequence-scoped watcher. Iterated over a copy: a watcher
   * may unsubscribe from inside its own callback. */
  private signalActivity(): void {
    for (const listener of [...this.activityListeners]) {
      listener();
    }
  }

  /**
   * Adapt this controller to the engine-neutral action seam.
   *
   * Built fresh per call and holding no state of its own: all state lives
   * in the controller, so a sequence cannot observe a stale view of the
   * page registry. The seam deliberately exposes no page *selection* —
   * acting on a page never changes which page the selected pointer names.
   */
  private actionSession(): ActionCapableSession {
    return {
      resolvePageId: (pageId) =>
        pageId === undefined
          ? this.registerPage(this.requirePage()).pageId
          : this.requireTrackedPage(pageId).pageId,
      documentSnapshot: (pageId) => this.documentSnapshotFor(pageId),
      describePage: (pageId) => this.describePage(this.requireTrackedPage(pageId)),
      describePageIdentity: (pageId) =>
        this.describePageIdentity(this.requireTrackedPage(pageId)),
      latestObservationId: (pageId) => this.state.latestObservationId(pageId),
      watchPage: (pageId) => this.createPageWatch(this.requireTrackedPage(pageId)),
      settleActionActivity: async () => {
        // Playwright can resolve a click while the corresponding context-page
        // event is still queued. Yield once so that event can establish a
        // claim, then await every claim that is already in flight. This keeps
        // an owned popup invisible until its opener/marker evidence is valid,
        // without making the generic navigation-detection window longer.
        await browserOwnershipEventTurn();
        await this.drainPendingPageClaims();
      },
      resolveTarget: async (target) =>
        actionTargetHandle(await this.resolveElementRef(target), this.uploadEncoder),
      navigate: async (pageId, url) => {
        assertHttpUrl(url);
        await this.requireTrackedPage(pageId).page.goto(url, {
          waitUntil: 'load',
          timeout: ACTION_NAVIGATION_TIMEOUT_MS,
        });
      },
      pressKey: async (pageId, key) => {
        // No timeout option exists (or is needed): a page-level keypress
        // waits for no element, it just dispatches.
        await this.requireTrackedPage(pageId).page.keyboard.press(key);
      },
      scrollPage: (pageId, direction, amount) =>
        scrollPageBy(this.requireTrackedPage(pageId).page, direction, amount),
      observe: (observeRequest) => this.observe(observeRequest),
      waitForSuccessChecks: (pageId, checks, timeoutMs, activity) =>
        waitForSuccessChecks(
          this.requireTrackedPage(pageId).page,
          checks,
          timeoutMs,
          activity,
        ),
      waitForDomQuiescence: (pageId, quietWindowMs, settleTimeoutMs) =>
        waitForDomQuiescence(
          this.requireTrackedPage(pageId).page,
          quietWindowMs,
          settleTimeoutMs,
        ),
      blockSignals: (pageId) => collectBlockSignals(this.requireTrackedPage(pageId)),
    };
  }

  /** Identity of a page's current main document with no renderer reads —
   * `page.url()` is driver-side state, so this is safe even mid-dialog. */
  private documentSnapshotFor(pageId: string): DocumentSnapshot {
    const record = this.requireTrackedPage(pageId);
    return {
      documentId: this.ensureFrameRecord(record, record.page.mainFrame()).documentId,
      url: record.page.url(),
    };
  }

  /**
   * Start recording page activity for one action sequence.
   *
   * Everything is reported as a *delta* from the moment the watch started:
   * pages that already existed, dialogs already pending, and downloads from
   * an earlier call must never be attributed to this sequence.
   */
  private createPageWatch(record: PageRecord): PageWatch {
    const startNavigations = record.navigationCount;
    // NOT `record.downloads.length`: that array evicts from the front past
    // MAX_TRACKED_DOWNLOADS_PER_PAGE, which would shift every remembered
    // index out from under a watch that outlives an eviction.
    // `totalDownloadsEver` never shrinks, so the delta below is correct
    // regardless of how much eviction happened while this watch was open.
    const startDownloadsEver = record.totalDownloadsEver;
    const priorDialogIds = new Set(this.pendingDialogs.keys());
    const priorPageIds = new Set(
      [...this.trackedPages.values()].map((tracked) => tracked.pageId),
    );
    const waiters = new Set<() => void>();
    const listener = (): void => {
      for (const waiter of [...waiters]) {
        waiter();
      }
    };
    this.activityListeners.add(listener);

    const activity = (): PageActivity => ({
      navigations: record.navigationCount - startNavigations,
      openedPageIds: [...this.trackedPages.values()]
        .filter((tracked) => !priorPageIds.has(tracked.pageId))
        .map((tracked) => tracked.pageId),
      dialogs: [...this.pendingDialogs.values()]
        .filter(
          (pending) =>
            !priorDialogIds.has(pending.info.dialogId) &&
            pending.info.pageId === record.pageId,
        )
        .map((pending) => pending.info),
      // The FIFO's front-eviction only ever removes the OLDEST entries and
      // pushes only append at the end, so "the last N entries" is always
      // exactly "the N most recently added" regardless of how many older
      // ones were evicted — computing the slice point from the current
      // length (rather than reusing a start-of-watch array index) is what
      // survives eviction. Clamped to 0: if more downloads happened since
      // the watch started than the array can retain, some have already
      // been evicted and cannot be recovered — reporting every entry
      // still held is the closest available answer, not a silent
      // undercount.
      downloads: record.downloads.slice(
        Math.max(0, record.downloads.length - (record.totalDownloadsEver - startDownloadsEver)),
      ),
    });

    return {
      activity,
      waitUntil: (predicate, timeoutMs) =>
        new Promise<void>((resolve) => {
          if (predicate(activity()) || timeoutMs <= 0) {
            resolve();
            return;
          }
          const finish = (): void => {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve();
          };
          const waiter = (): void => {
            if (predicate(activity())) finish();
          };
          const timer = setTimeout(finish, timeoutMs);
          waiters.add(waiter);
        }),
      stop: () => {
        waiters.clear();
        this.activityListeners.delete(listener);
      },
    };
  }

  private requirePage(): Page {
    this.requireOpenContext();
    const page = this.activePage;
    if (page === undefined || page.isClosed()) {
      this.activePage = undefined;
      throw new Error('No browser task tab is active; call newTab() first.');
    }

    return page;
  }

  private requireNoActiveTaskPage(): void {
    if (this.activePage !== undefined && !this.activePage.isClosed()) {
      throw new Error('A browser task tab is already active; close it first.');
    }
  }

  /** Serialize tab mutation while allowing a cancelled/timed-out caller to
   * return before a non-cooperative provider effect. The lifecycle queue and
   * shared exclusive ledger remain tied to the real containment promise, so
   * cleanup/rebinding cannot overtake it. */
  private runTabLifecycleWithContainment<T>(
    operation: (holdForContainment: (effect: Promise<unknown>) => void) => Promise<T>,
  ): Promise<T> {
    const priorLifecycle = this.tabLifecycle;
    let releaseLifecycle!: () => void;
    const lifecycleFence = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    let lifecycleHolds = 0;
    let lifecycleReleased = false;
    const release = (): void => {
      if (lifecycleReleased) return;
      lifecycleReleased = true;
      releaseLifecycle();
    };
    const holdForContainment = (effect: Promise<unknown>): void => {
      lifecycleHolds += 1;
      this.busyRegistry?.markAbandoned(EXCLUSIVE_ACCESS, effect);
      void effect.then(
        () => {
          lifecycleHolds -= 1;
          if (lifecycleHolds === 0) release();
        },
        () => {
          lifecycleHolds -= 1;
          if (lifecycleHolds === 0) release();
        },
      );
    };

    const result = priorLifecycle.then(async () => {
      try {
        return await operation(holdForContainment);
      } finally {
        if (lifecycleHolds === 0) release();
      }
    });
    this.tabLifecycle = lifecycleFence;
    return result;
  }

  private serializeTabLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tabLifecycle.then(operation);
    this.tabLifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Bound a read that depends on the page's main thread — see the
   * module-level {@link withRendererDeadline} for the actual timeout
   * mechanics.
   *
   * On timeout, the abandoned read is registered with `this.busyRegistry`
   * (when set) as a possibly-still-busy READ on `accessKey.page(pageId ??
   * 'selected')` — the SAME key a tool's own `getAccess()` computes from its
   * own optional `pageId` input (see `captureText.ts`/`observe.ts`), so an
   * abandoned read here forms a barrier against exactly the later calls that
   * would actually race it: an omitted `pageId` collapses to the shared
   * `'page:selected'` key every unqualified call contends for, and a named
   * `pageId` collapses to that one page's own key instead. Passing the
   * caller's OWN optional `pageId` argument through — not the concretely
   * resolved page's stable id — is what keeps this aligned with the
   * tool-layer's pre-execution declaration, which can only ever know "named
   * page X" or "whichever page is selected", never a resolved identity.
   * See `BusyResourceRegistry`'s module doc for why registering it as a read
   * still lets a later WRITE (a fill, click, or navigate on the same page)
   * wait for it, which is the actual race this closes: a stuck read left
   * running in the background while a later action starts mutating the
   * page it never finished reading.
   */
  private withRendererDeadline<T>(
    read: () => Promise<T>,
    timeoutMs: number,
    fallback?: T,
    pageId?: string,
  ): Promise<T> {
    return withRendererDeadline(read, timeoutMs, fallback, (started) => {
      if (this.busyRegistry !== undefined) {
        this.busyRegistry.markAbandoned(
          { reads: [accessKey.page(pageId ?? 'selected')], writes: [] },
          started,
        );
      } else {
        void started.catch(() => undefined);
      }
    });
  }

  /**
   * Resolve the page an implicit-page-or-explicit-`pageId` method
   * (screenshot, download, currentUrl, title, executeJavaScript,
   * prepareForBrowserScript) should act on.
   *
   * @param pageId - explicit page, or undefined for the selected page
   * @returns the selected task tab when `pageId` is omitted, or exactly the
   *   named tracked page otherwise — never a fallback like "the first open
   *   tab"
   * @throws Error when `pageId` is omitted and no task tab is active, or a
   *   named `pageId` is unknown or closed
   */
  private pageFor(pageId?: string): Page {
    return pageId === undefined ? this.requirePage() : this.requireTrackedPage(pageId).page;
  }
}

/**
 * Wait for a set of success checks to all pass.
 *
 * This is the only wait that pursues a *caller-defined* outcome; the quiet
 * window below is a heuristic. Checks are polled rather than event-driven so
 * a check can be satisfied by anything (text, URL, a download, a popup)
 * without the caller having to name the mechanism.
 *
 * @param page - the page the checks are evaluated against
 * @param checks - checks in request order
 * @param timeoutMs - finite total budget (already clamped by the caller)
 * @param activity - live sequence activity, for download/popup checks
 * @returns one outcome per check, in request order. A check that never
 *   passes returns `passed: false` — never an exception, because a failed
 *   check is a result (`failed_check`), not an error
 */
export async function waitForSuccessChecks(
  page: Page,
  checks: readonly SuccessCheck[],
  timeoutMs: number,
  activity: () => PageActivity,
): Promise<SuccessCheckOutcome[]> {
  const outcomes: SuccessCheckOutcome[] = checks.map((check) => ({
    check,
    passed: false,
  }));
  if (outcomes.length === 0) return outcomes;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const outcome of outcomes) {
      if (!outcome.passed) {
        outcome.passed = await evaluateSuccessCheck(page, outcome.check, activity());
      }
    }
    if (outcomes.every((outcome) => outcome.passed) || Date.now() >= deadline) {
      return outcomes;
    }
    await delay(CHECK_POLL_INTERVAL_MS);
  }
}

/**
 * Wait until the page's DOM stops changing.
 *
 * Deliberately NOT `networkidle`: on live applications with polling,
 * analytics, or open sockets, network idle never arrives, so a run that
 * waits for it either hangs or learns to ignore the wait entirely. A
 * relevant-DOM quiet window is observable, bounded, and honest about what
 * it measured.
 *
 * @param page - page to observe
 * @param quietWindowMs - mutation-free span that counts as quiet
 * @param settleTimeoutMs - total budget for reaching that span
 * @returns true when a full quiet window elapsed; false when the budget ran
 *   out (an animation, a poller) or quiescence could not be measured at all
 *   (navigation destroyed the context, the renderer is blocked). Never
 *   rejects: "not settled" is a fact the caller reports, not a failure
 */
export async function waitForDomQuiescence(
  page: Page,
  quietWindowMs: number,
  settleTimeoutMs: number,
): Promise<boolean> {
  const inPage = page
    .evaluate(
      ({ quiet, budget }) =>
        new Promise<boolean>((resolve) => {
          let lastMutation = performance.now();
          const started = lastMutation;
          const observer = new MutationObserver(() => {
            lastMutation = performance.now();
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          const tick = (): void => {
            const now = performance.now();
            if (now - lastMutation >= quiet) {
              observer.disconnect();
              resolve(true);
              return;
            }
            if (now - started >= budget) {
              observer.disconnect();
              resolve(false);
              return;
            }
            setTimeout(tick, Math.min(quiet, 50));
          };
          setTimeout(tick, Math.min(quiet, 50));
        }),
      { quiet: quietWindowMs, budget: settleTimeoutMs },
    )
    // A navigation mid-wait destroys the execution context; the caller
    // learns about the navigation from the observation, and quiescence
    // simply was not observed.
    .catch(() => false);

  // Node-side backstop: a renderer that never runs our timers (frozen page,
  // modal dialog) must not turn a bounded wait into a hang.
  return Promise.race([
    inPage,
    delay(settleTimeoutMs + QUIESCENCE_OVERHEAD_MS).then(() => false),
  ]);
}

/** Evaluate one success check. Any engine error counts as "not yet": the
 * page may be mid-navigation, and the poll loop will ask again. */
async function evaluateSuccessCheck(
  page: Page,
  check: SuccessCheck,
  activity: PageActivity,
): Promise<boolean> {
  try {
    switch (check.type) {
      case 'url_matches':
        return matchesUrlPattern(page.url(), check.pattern);
      case 'element_exists':
        return (
          (await page
            .getByRole(check.role as Parameters<Page['getByRole']>[0], {
              name: check.name,
            })
            .count()) > 0
        );
      case 'text_present': {
        const text = await withRendererDeadline(
          () => page.evaluate(() => document.body?.innerText ?? ''),
          RENDERER_READ_TIMEOUT_MS,
          '',
        );
        return text.includes(check.text);
      }
      case 'download_started':
        return activity.downloads.length > 0;
      case 'popup_opened':
        return activity.openedPageIds.length > 0;
    }
  } catch {
    return false;
  }
}

/** Match a URL against a caller pattern: a regular expression when it
 * compiles, plain containment otherwise. A model that writes
 * `example.com/orders?id=1` means containment, and failing the check on a
 * regex syntax error would hide a page that actually loaded. */
function matchesUrlPattern(url: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return url.includes(pattern);
  }
}

/** Scroll one page by pixels or viewport multiples. The viewport height is
 * read inside the page so the amount means what the page sees, not what a
 * configured viewport claims. */
async function scrollPageBy(
  page: Page,
  direction: ScrollDirection,
  amount: ScrollAmount,
): Promise<void> {
  const sign = direction === 'up' ? -1 : 1;
  await withRendererDeadline(
    () =>
      page.evaluate(
        ({ unit, value, signum }) => {
          const distance = unit === 'viewport' ? window.innerHeight * value : value;
          window.scrollBy(0, distance * signum);
        },
        { unit: amount.unit, value: amount.value, signum: sign },
      ),
    RENDERER_READ_TIMEOUT_MS,
  );
  await page.waitForTimeout(SCROLL_SETTLE_MS);
}

/** Collect the evidence a blocked classification is drawn from. Bounded and
 * best-effort: an unreadable page yields empty signals (classified as "not
 * blocked") rather than failing the whole action result. */
async function collectBlockSignals(record: PageRecord): Promise<BlockSignals> {
  const page = record.page;
  const probe = await withRendererDeadline(
    () =>
      page.evaluate((maxChars) => {
        const text = document.body?.innerText ?? '';
        return {
          text: text.slice(0, maxChars),
          hasPasswordField: document.querySelector('input[type="password"]') !== null,
        };
      }, MAX_BLOCK_TEXT_CHARS),
    RENDERER_READ_TIMEOUT_MS,
    { text: '', hasPasswordField: false },
  ).catch(() => ({ text: '', hasPasswordField: false }));

  const url = page.url();
  const response = record.lastMainResponse;
  return {
    url,
    text: probe.text,
    hasPasswordField: probe.hasPasswordField,
    frameUrls: page
      .frames()
      .slice(0, MAX_BLOCK_FRAME_URLS)
      .map((frame) => frame.url()),
    // Only when the response really produced the document on screen; a
    // stale 403 from a previous URL must not label this page blocked.
    ...(response !== undefined && response.url === url
      ? {
          status: response.status,
          ...(response.retryAfterHeader !== undefined
            ? { retryAfterHeader: response.retryAfterHeader }
            : {}),
        }
      : {}),
  };
}

/** Map Playwright's dialog type string onto the reported union. Unknown
 * types are reported as `alert`: the caller's only real decision is
 * accept/dismiss, and an unmapped type must not break the result. */
function normalizeDialogType(type: string): BrowserDialog['type'] {
  return type === 'confirm' || type === 'prompt' || type === 'beforeunload'
    ? type
    : 'alert';
}

/** Derive a stable browser marker without placing the caller's local run id
 * into page state. Including the versioned namespace in the digest separates
 * this use from any other hash of the same opaque id. */
function runPageOwnershipMarker(ownershipId: string): string {
  if (typeof ownershipId !== 'string' || ownershipId.length === 0) {
    throw new TypeError('Durable run page ownership requires a non-empty string id.');
  }
  if (Buffer.byteLength(ownershipId, 'utf8') > MAX_RUN_PAGE_OWNERSHIP_ID_BYTES) {
    throw new RangeError(
      `Durable run page ownership ids may not exceed ` +
        `${MAX_RUN_PAGE_OWNERSHIP_ID_BYTES} UTF-8 bytes.`,
    );
  }
  const digest = createHash('sha256')
    .update(RUN_PAGE_OWNERSHIP_MARKER_PREFIX, 'utf8')
    .update('\0', 'utf8')
    .update(ownershipId, 'utf8')
    .digest('base64url');
  return `${RUN_PAGE_OWNERSHIP_MARKER_PREFIX}${digest}`;
}

/** Exact browser-only URL used between Chromium target commit and durable
 * page-marker installation. It contains only a namespace-separated digest of
 * the already-hashed marker; neither the durable run id nor a filesystem path
 * crosses into target metadata. */
function runPageTargetSentinel(marker: string): string {
  const digest = createHash('sha256')
    .update(RUN_PAGE_TARGET_SENTINEL_PREFIX, 'utf8')
    .update('\0', 'utf8')
    .update(marker, 'utf8')
    .digest('base64url');
  return `about:blank#${RUN_PAGE_TARGET_SENTINEL_PREFIX}${digest}`;
}

function rawTargetCreationUrl(params: Record<string, unknown>): string {
  if (
    Object.keys(params).length !== 1 ||
    typeof params.url !== 'string' ||
    params.url.length === 0 ||
    Buffer.byteLength(params.url, 'utf8') > MAX_RAW_TARGET_URL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(params.url)
  ) {
    throw new TypeError(
      'Run-owned Target.createTarget accepts exactly one bounded URL parameter.',
    );
  }
  try {
    new URL(params.url);
  } catch {
    throw new TypeError(
      'Run-owned Target.createTarget requires an absolute URL.',
    );
  }
  return params.url;
}

/** Read only an equality bit out of the page. The marker itself never comes
 * back through Playwright, so it cannot accidentally enter an error,
 * diagnostic, page listing, or tool result. */
async function pageHasRunOwnershipMarker(page: Page, marker: string): Promise<boolean> {
  return withRunPageOwnershipEvaluationDeadline(
    page.evaluate(
      ({ property, marker: expectedMarker }: { property: string; marker: string }) => {
        const descriptor = Object.getOwnPropertyDescriptor(window, property);
        return (
          descriptor?.value === expectedMarker &&
          descriptor.enumerable === false &&
          descriptor.configurable === false &&
          descriptor.writable === false
        );
      },
      { property: RUN_PAGE_OWNERSHIP_PROPERTY, marker },
    ),
  );
}

/** Browser startup cannot trust a provider promise to observe cancellation.
 * Install the operation handlers first, then establish caller-supplied
 * containment before rejecting on abort. Once the signal fires, containment
 * wins over a provider promise settling at the same boundary. */
function raceBrowserPreparationStep<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  containOnAbort: () => void | Promise<void>,
): Promise<T> {
  if (signal === undefined) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborting = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => {
      if (aborting || settled) return;
      aborting = true;
      void Promise.resolve()
        .then(containOnAbort)
        .then(
          () => finish(() => reject(signal.reason)),
          (error) => finish(() => reject(error)),
        );
    };

    operation.then(
      (value) => {
        if (!aborting) finish(() => resolve(value));
      },
      (error) => {
        if (!aborting) finish(() => reject(error));
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function browserOwnershipEventTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Renderer inspection cannot inherit Playwright's global 30s+ waits: this
 * gate runs before a resumed coordinator may safely do anything else. The
 * losing evaluation is read-only (or an idempotent exact marker install) and
 * is observed so a later driver rejection cannot become unhandled. */
async function withRunPageOwnershipEvaluationDeadline<T>(
  evaluation: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Durable page ownership inspection timed out.')),
      RUN_PAGE_OWNERSHIP_EVALUATION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([evaluation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void evaluation.catch(() => undefined);
  }
}

/**
 * @returns the surviving pre-existing session page — never tracked, never
 *   closed by this codebase, and deliberately excluded from
 *   {@link PlaywrightBrowserController}'s page registry for the whole
 *   session. The caller threads it into the controller's constructor so a
 *   later `context.pages()` rescan (see `doRefreshAfterBrowserScript`) can
 *   keep excluding it too, instead of accidentally adopting it as a
 *   "tracked page" the first time anything inspects `context.pages()`
 *   directly.
 *
 * Exported so a remote provider prepares its default context's blank page
 * through the SAME code as a local launch. A second implementation of "which
 * page is the session page" is exactly how a provider ends up with a tracked
 * page the local one excludes.
 */
export async function prepareSessionPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  const sessionPage = pages[0] ?? (await context.newPage());

  for (const extraPage of pages.slice(1)) {
    await extraPage.close();
  }

  if (sessionPage.url() !== 'about:blank') {
    await sessionPage.goto('about:blank');
  }

  return sessionPage;
}

/** Dedupe requested needs preserving order; an omitted request means the
 * compact interactive outline. */
function normalizeNeeds(
  needs: readonly ObservationNeed[] | undefined,
): ObservationNeed[] {
  if (needs === undefined) {
    return ['interactive'];
  }
  const unique = [...new Set(needs)];
  if (unique.length === 0) {
    throw new TypeError('observe requires at least one observation need.');
  }
  return unique;
}

/** Cut a view's content at the per-view bound (an evicted-baseline full
 * snapshot must stay bounded even before the pipeline's byte cap). */
function makeBoundedView(need: ObservationNeed, content: string): ObservationView {
  if (content.length <= MAX_VIEW_CONTENT_CHARS) {
    return { need, content, truncated: false };
  }
  return { need, content: content.slice(0, MAX_VIEW_CONTENT_CHARS), truncated: true };
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Browser URL must be absolute: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Browser URL must use HTTP or HTTPS: ${url}`);
  }
}

/** Exported for downloadCapture.ts, the only other place this is used. */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Exported for downloadCapture.ts, the only other place this is used. */
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * Does `source` PARSE? `new Function` compiles the body and throws
 * SyntaxError without executing a single statement of it, so this answers a
 * pure syntax question and runs nothing. Node and the page are both V8,
 * which is what makes an answer here trustworthy about there.
 *
 * Exported for pageJavaScript.ts, which re-checks a candidate with this same
 * function to decide whether execute-JavaScript's expression/statement retry
 * is safe (see {@link evaluationSources} below for the two candidates, and
 * pageJavaScript.ts's `evaluateJavaScript` for how the retry decision uses
 * this).
 */
export function parses(source: string): boolean {
  try {
    new Function(`return ${source};`);
    return true;
  } catch {
    return false;
  }
}

/** How many trailing statement boundaries to consider for the
 * completion-value split. A handful covers real snippets, and the bound keeps
 * a pathological body from turning into hundreds of compiles. */
const MAX_COMPLETION_SPLIT_CANDIDATES = 12;

/** Ceiling for one renderer read (see the class's withRendererDeadline
 * method). Generous beside a healthy read, which returns in single-digit
 * milliseconds: a read that needs five seconds is a page in trouble, not a
 * page being slow. */
const RENDERER_READ_TIMEOUT_MS = 5_000;

/**
 * Bound a read that depends on the page's main thread.
 *
 * `page.evaluate`, `page.title`, and `page.ariaSnapshot` all run code in the
 * renderer and none of them accepts a timeout, so a page whose main thread is
 * saturated — a heavy app re-rendering on every keystroke, say — makes them
 * wait indefinitely. Note that `.catch()` on such a call bounds a REJECTION,
 * not a hang: a wedged renderer never settles either way, which is why
 * several reads here looked protected and were not. Measured live on
 * 2026-08-13, a `browser_action` fill stopped returning for ten minutes on
 * exactly this.
 *
 * @param read - starts the renderer read; called immediately
 * @param fallback - value to use when the deadline wins, for reads where a
 *   missing answer is survivable (a page title, block-detection text). A read
 *   whose absence would silently corrupt an observation passes none, and its
 *   rejection propagates instead.
 * @param onAbandoned - called once, only on an actual timeout, with the
 *   still-running `started` promise — the caller's chance to register it
 *   with a `BusyResourceRegistry` under the correct access key instead of
 *   silently swallowing it. Omitted callers (the three free-standing
 *   action-sequence helpers below, which read an explicit, possibly
 *   non-selected `Page` rather than `this.requirePage()` and so have no
 *   single unambiguous key to register under) get the old behavior exactly:
 *   the abandoned read's eventual rejection is swallowed, since nobody is
 *   listening for it any more and an unhandled rejection must not surface in
 *   a later turn that has nothing to do with it. See
 *   `PlaywrightBrowserController.withRendererDeadline` for the wrapper every
 *   OTHER call site uses, which always supplies one.
 */
async function withRendererDeadline<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  fallback?: T,
  onAbandoned?: (started: Promise<T>) => void,
): Promise<T> {
  const started = read();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      started,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (fallback === undefined) {
            reject(
              new Error(
                `The page stopped responding to reads for ${timeoutMs}ms; its main ` +
                  `thread is likely busy. Observe it again, or take a different route.`,
              ),
            );
            return;
          }
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      if (onAbandoned !== undefined) {
        onAbandoned(started);
      } else {
        void started.catch(() => undefined);
      }
    }
  }
}

/**
 * Rewrite `STATEMENTS; EXPRESSION` into `STATEMENTS; return (EXPRESSION);` —
 * the completion-value semantics a console gives you — or return undefined
 * when the snippet is not that shape.
 *
 * A split is accepted only when BOTH halves parse independently: the head as
 * a complete statement list, the tail as an expression. Parsing the joined
 * candidate is NOT sufficient, and the counterexample is why this function
 * can be trusted. `for (const r of rows) doThing(r)` splits into a head of
 * `for (const r of rows)` and a tail of `doThing(r)`; the joined form
 * `for (const r of rows) return (doThing(r));` parses happily while meaning
 * something entirely different — returning on the first iteration instead of
 * looping. The head alone does not parse, which is exactly how that candidate
 * is rejected. Requiring each half to stand alone is what makes appending a
 * `return` meaning-preserving rather than a guess.
 */
function completionValueSource(code: string): string | undefined {
  const body = code.replace(/\s+$/, '').replace(/;+$/, '');
  const boundaries: number[] = [];
  // Scanned from the END, so the smallest trailing expression is tried
  // first — `a; b + \n c` must split at the `;`, not at the newline.
  for (
    let index = body.length;
    index > 0 && boundaries.length < MAX_COMPLETION_SPLIT_CANDIDATES;
    index -= 1
  ) {
    const previous = body[index - 1]!;
    if (previous === ';' || previous === '}' || previous === '\n') boundaries.push(index);
  }

  for (const index of boundaries) {
    const tail = body.slice(index).trim();
    if (tail === '') continue;
    const head = body.slice(0, index);
    if (!parses(`(async () => {\n${head}\n})()`)) continue;
    if (!parses(`(async () => { return (\n${tail}\n); })()`)) continue;
    return `(async () => {\n${head}\nreturn (\n${tail}\n);\n})()`;
  }
  return undefined;
}

/**
 * The wrappings to try for a model-supplied snippet, in order.
 *
 * 1. **Expression** — `return (CODE)`. Covers a bare expression
 *    (`document.title`) and a self-invoking function, the two forms a person
 *    writing a console one-liner reaches for first. A trailing semicolon is
 *    stripped because `return (x;)` will not parse.
 * 2. **Completion value** — `STATEMENTS; return (LAST_EXPRESSION);` when the
 *    snippet is that shape (see completionValueSource). This is what a model
 *    writes when it builds a result across several statements and names it on
 *    the last line, and measured live on 2026-08-13 it was the FIRST thing
 *    the worker tried on a real extraction.
 * 3. **Statement** — the raw body. Covers multi-statement code with an
 *    explicit top-level `return`, and is the only shape that can express an
 *    early return.
 *
 * All are wrapped in an ASYNC arrow so `await` works at the snippet's top
 * level; Playwright resolves the returned promise before serializing, so a
 * synchronous snippet is unaffected.
 *
 * Order matters for correctness, not just speed: form 3 PARSES for a
 * completion-value snippet and quietly evaluates to undefined, so it must
 * never be tried before form 2. Forms that cannot parse at all are dropped
 * here rather than attempted, and since the caller retries only on a
 * SyntaxError — a parse failure proves nothing ran — no snippet's side
 * effects can happen twice.
 */
export function evaluationSources(code: string): string[] {
  const expression = code.trim().replace(/;+$/, '');
  const asExpression = `(async () => { return (\n${expression}\n); })()`;
  const asStatements = `(async () => {\n${code}\n})()`;
  const asCompletionValue = completionValueSource(code);
  const expressionParses = parses(asExpression);
  return [
    ...(expressionParses ? [asExpression] : []),
    ...(asCompletionValue === undefined ? [] : [asCompletionValue]),
    asStatements,
    // Nothing parsed, so the page must still be sent something in order to
    // report the real SyntaxError rather than this code guessing at intent.
    ...(expressionParses || asCompletionValue !== undefined || parses(asStatements)
      ? []
      : [asExpression]),
  ];
}
