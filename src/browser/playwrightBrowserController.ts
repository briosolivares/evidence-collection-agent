import type { BrowserContext, Dialog, Disposable, Page } from 'playwright';

import {
  type BrowserDialog,
  type BrowserCommandSession,
  type BrowserController,
  type BrowserDownloadResult,
  type BrowserDownloadTarget,
  type BrowserOperationOptions,
  type BrowserPage,
  type BrowserScreenshotOptions,
  type BrowserTaskPagePreparation,
} from './controller.js';
import type { BrowserSessionDiagnostics } from './sessionProvider.js';
import { localDownloadReader, type BrowserDownloadReader } from './downloadReader.js';
import { localUploadEncoder, type BrowserUploadEncoder } from './uploadEncoder.js';
import type { BusyResourceRegistry } from '../tools/registry.js';
import { captureClickDownload, captureUrlThroughChrome } from './downloadCapture.js';
import { withBackendNodeLocator } from './backendNodeTarget.js';
import {
  openPlaywrightCommandSession,
  type BrowserTargetCommandPolicy,
} from './browserCommandSession.js';
import {
  ChromiumTargetControlError,
  type ChromiumPageTargetRef,
  type ChromiumTargetControl,
} from './chromiumTargetControl.js';
import { raceWithAbortContainment, settleWithin } from './boundedSettlement.js';
import {
  installRunOwnershipInheritScript,
  markPageWithRunOwnership,
  pageHasRunOwnershipMarker,
  runPageOwnershipMarker,
  runPageTargetSentinel,
  withRunPageOwnershipEvaluationDeadline,
} from './runPageOwnership.js';
import { resolvePageTarget } from './targetResolution.js';

/** Compatibility re-exports: the local provider and shared session-page
 * preparation moved to their own modules, but callers outside src/browser
 * (the login CLI, agent/tool tests) still import them from here. */
export {
  launchPersistentChrome,
  LocalChromeBrowserSessionProvider,
  pinProfileDownloadDirectory,
  type LocalChromeBrowserSessionOptions,
} from './localChromeSessionProvider.js';
export { prepareSessionPage } from './controllerAssembly.js';

const MAX_RAW_TARGET_URL_BYTES = 16_384;
const RAW_TARGET_PAGE_APPEAR_TIMEOUT_MS = 2_000;
const RAW_TARGET_PAGE_POLL_MS = 10;
const MAX_RUN_PAGE_OWNERSHIP_RECOVERY_PASSES = 10;
const MAX_RUN_PAGE_OWNERSHIP_CLEANUP_PASSES = 10;
const RUN_PAGE_OWNERSHIP_CLEAN_PASSES = 2;
const TARGET_CREATION_NAVIGATION_TIMEOUT_MS = 5_000;
const BROWSER_PREPARATION_CONTAINMENT_TIMEOUT_MS = 5_000;
const ABANDONED_COMMAND_PAGE_CLOSE_TIMEOUT_MS = 2_000;

/** Runtime identity for one page owned by this controller. */
interface PageRecord {
  pageId: string;
  page: Page;
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
  /** Pages that existed before this controller began owning task work —
   * permanently excluded from the page registry. Attached Chrome may have
   * many user-owned tabs, while managed providers normally pass only the
   * singular option above. Without this set, an external-command refresh
   * would silently adopt unrelated user pages and expose them through
   * {@link PlaywrightBrowserController.pages} and popup/task-tab fallbacks
   * report. */
  preexistingSessionPages?: readonly Page[];
  /** Context-scoped Chromium target capability used for crash-recoverable
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
  private pageSequence = 0;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private tabLifecycle: Promise<void> = Promise.resolve();
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
  /** Coalesce creation-event and target-preparation claims for the same page.
   * Chromium can publish its Page while the direct target path is still
   * installing the marker; running both marker evaluations independently
   * lets the later one become trapped behind an immediately opened dialog. */
  private readonly durablePageClaims = new WeakMap<Page, Promise<PageRecord>>();
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
   * accept. The cost is that a page with an unanswered dialog runs no script
   * until a later command session sends an explicit decision. */
  private readonly pendingDialogs = new Map<string, PendingDialogRecord>();
  /** Command-session detachers transferred to the controller because their
   * in-flight renderer command opened a dialog. Detaching that session first
   * makes Chrome silently dismiss the dialog; retaining it until the explicit
   * decision preserves the no-automatic-answer contract. */
  private readonly deferredCommandSessionDetachers = new Map<string, Set<() => Promise<void>>>();
  /** Page ids whose command session was released with a raw command still in
   * flight and no dialog explaining the block. Refresh retires those exact
   * owned targets before exposing the browser to another program. */
  private readonly pagesWithAbandonedCommands = new Set<string>();
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
  /** Set via {@link setBusyRegistry}; undefined until `runAgent` binds this
   * controller, or in a test that constructs it directly. */
  private busyRegistry: BusyResourceRegistry | undefined;

  private readonly context: BrowserContext;
  private readonly preexistingSessionPages: ReadonlySet<Page>;
  private readonly targetControl: ChromiumTargetControl | undefined;
  private readonly closeSession: () => Promise<void>;
  private readonly downloadReader: BrowserDownloadReader;
  private readonly uploadEncoder: BrowserUploadEncoder;
  readonly sessionDiagnostics: BrowserSessionDiagnostics | undefined;

  constructor(options: PlaywrightBrowserControllerOptions) {
    this.context = options.context;
    this.preexistingSessionPages = new Set(options.preexistingSessionPages ?? []);
    this.targetControl = options.targetControl;
    this.closeSession = options.closeSession ?? (() => this.context.close());
    this.downloadReader = options.downloadReader ?? localDownloadReader;
    this.uploadEncoder = options.uploadEncoder ?? localUploadEncoder;
    this.sessionDiagnostics = options.sessionDiagnostics;
    // A context page event alone is not ownership evidence in attached mode:
    // it may be a user opening a tab concurrently. Task tabs claim themselves
    // during task-page preparation; this listener claims only popups of an owned page or exact
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

  private async navigateTaskPage(
    url: string,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    this.requirePreparationBusyRegistry(options.signal);
    assertHttpUrl(url);
    options.signal?.throwIfAborted();
    const page = this.requirePage();
    await raceBrowserPreparationStep(page.goto(url, { waitUntil: 'load' }), options.signal, () =>
      this.containAbortedTaskPage(page),
    );
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<Uint8Array> {
    const bytes = await this.pageFor(options.pageId).screenshot({
      fullPage: options.fullPage ?? false,
      ...(options.scale === undefined ? {} : { scale: options.scale }),
      type: 'png',
    });
    return new Uint8Array(bytes);
  }

  async download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult> {
    this.requireOpenContext();
    const page = this.pageFor(target.pageId);

    if ('url' in target) {
      assertHttpUrl(target.url);
      return this.captureUrlThroughChrome(target.url, page);
    }

    const commandSession = await this.openCommandSession(target.pageId);
    try {
      return await withBackendNodeLocator(
        page,
        (method, params) => commandSession.send(method, params),
        target.backendNodeId,
        async (locator) => {
          let href: string | null;
          try {
            href = await locator.evaluate((element) => {
              const value = element.getAttribute('href');
              return value === null ? null : new URL(value, element.ownerDocument.baseURI).href;
            });
          } catch {
            throw new Error(
              `Browser backend node ${target.backendNodeId} could not be inspected for download.`,
            );
          }

          if (href !== null && isHttpUrl(href)) {
            return this.captureUrlThroughChrome(href, page);
          }
          return captureClickDownload(
            locator,
            `Browser backend node ${target.backendNodeId}`,
            page,
            this.downloadReader,
          );
        },
      );
    } finally {
      await commandSession.close();
    }
  }

  /** Capture a download reached by navigating a throwaway page straight to
   * `url`; see {@link captureUrlThroughChrome} in downloadCapture.ts for the
   * mechanics, and its doc for why the `pendingInternalPages` counter is
   * threaded through as two explicit callbacks rather than that module
   * reaching into this controller's state directly. */
  private captureUrlThroughChrome(
    url: string,
    referringPage: Page,
  ): Promise<BrowserDownloadResult> {
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

  async pages(): Promise<BrowserPage[]> {
    this.requireOpenContext();
    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();

    const liveRecords = [...this.trackedPages.values()].filter((record) => !record.page.isClosed());
    return liveRecords.map((record) => this.describePage(record));
  }

  async openCommandSession(pageId?: string): Promise<BrowserCommandSession> {
    this.requireOpenContext();
    this.requireHealthyRunPageOwnership();
    // Resolve controller identity exactly once before attachment. Task-page
    // preparation already registers the selected page; registerPage is
    // idempotent for any later lifecycle path that restores selection.
    const record =
      pageId === undefined
        ? this.registerPage(this.requirePage())
        : this.requireTrackedPage(pageId);
    const epoch = this.captureRunPageOwnershipEpoch();
    const targetPolicy: BrowserTargetCommandPolicy = {
      ownedTargetIds: () => this.ownedTargetIdsForCommand(epoch),
      createTarget: async (params, rawCreate) => {
        if (epoch.marker !== undefined) {
          return this.createRawRunTarget(params, epoch);
        }
        const result = await rawCreate(params);
        const targetId = (result as { targetId?: unknown })?.targetId;
        if (typeof targetId !== 'string' || targetId.length === 0) {
          throw new Error('Target.createTarget returned no target id');
        }
        await this.claimRawCreatedTarget(targetId, epoch);
        return result;
      },
    };
    return openPlaywrightCommandSession(this.context, record.page, record.pageId, {
      targetPolicy,
      handleDialogCommand: (params) => this.handleRawDialogCommand(record.pageId, params),
      uploadEncoder: this.uploadEncoder,
      trackUploadEffect: (effect) => this.busyRegistry?.markAbandoned(effect),
      release: (detach, hadPendingCommands) =>
        this.releaseCommandSession(record.pageId, detach, hadPendingCommands),
    });
  }

  /**
   * Resolve the complete target authority for one command-session epoch.
   * Pending opener/creation claims are drained and external pages reconciled
   * before taking the snapshot; unrelated context pages remain excluded.
   */
  private async ownedTargetIdsForCommand(
    epoch: RunPageOwnershipEpoch,
  ): Promise<ReadonlySet<string>> {
    this.requireOpenContext();
    this.requireHealthyRunPageOwnership();
    if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
      throw new Error('The browser command session belongs to an ended task-page ownership epoch.');
    }

    await this.drainPendingPageClaims();
    await this.reconcileExternalPages();
    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();

    const targetIds = new Set<string>();
    for (const page of this.ownedPages) {
      if (page.isClosed()) continue;
      const targetId = await this.targetIdForPage(page);
      if (targetId === undefined) {
        throw new Error('Could not resolve the complete owned browser target inventory.');
      }
      targetIds.add(targetId);
    }
    for (const [targetId, generation] of this.pendingOwnedTargetIds) {
      if (generation === epoch.generation) targetIds.add(targetId);
    }
    return targetIds;
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

  async refreshAfterExternalCommands(): Promise<void> {
    this.requireOpenContext();
    await this.retirePagesWithAbandonedCommands();
    await this.drainPendingPageClaims();
    this.requireHealthyRunPageOwnership();
    await this.reconcileExternalPages();
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
    return raceBrowserPreparationStep(initialization, options.signal, () => {
      this.busyRegistry?.markAbandoned(initialization);
    });
  }

  private async initializeRunPageOwnershipUnserialized(ownershipId: string): Promise<void> {
    this.requireOpenContext();
    const marker = runPageOwnershipMarker(ownershipId);
    if (this.runPageOwnershipMarker !== undefined) {
      if (this.runPageOwnershipMarker !== marker) {
        throw new Error('This browser controller is already bound to a different durable run.');
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
      throw new Error('Durable run page ownership must be initialized before opening a task page.');
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
      // Per-page scripts installed by claimDurablyOwnedPage remain the
      // unconditional navigation-persistence layer after positive claim; this
      // context script only handles opener inheritance for popups.
      initScript = await installRunOwnershipInheritScript(this.context, marker);
    } catch {
      throw new Error('Could not arm durable page ownership for this browser session.');
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

    for (let pass = 0; pass < MAX_RUN_PAGE_OWNERSHIP_RECOVERY_PASSES; pass += 1) {
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

    throw new Error('Durable run target recovery did not converge after its bounded scans.');
  }

  async prepareTaskPage(request: BrowserTaskPagePreparation): Promise<void> {
    request.signal?.throwIfAborted();
    if (this.targetControl === undefined) {
      throw new Error('Crash-recoverable task-page preparation requires provider target control.');
    }
    await this.initializeRunPageOwnership(request.ownershipId, {
      signal: request.signal,
    });
    request.signal?.throwIfAborted();
    await this.openDurableTaskTarget({ signal: request.signal });
    if (request.startUrl !== undefined) {
      await this.navigateTaskPage(request.startUrl, { signal: request.signal });
    }
  }

  /** Open the task page through an exact hashed sentinel target. A process
   * killed before the page marker is installed leaves that sentinel behind;
   * same-run recovery can therefore identify it without guessing from page
   * order or exposing the raw durable run id. */
  private openDurableTaskTarget(options: BrowserOperationOptions): Promise<void> {
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
    if (epoch.marker === undefined || !this.isCurrentRunPageOwnershipEpoch(epoch)) {
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

  private async stripRunTargetSentinel(page: Page, sentinelUrl: string): Promise<void> {
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
          throw new Error('Could not remove durable task-page ownership from the browser context.');
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

  /** Rescan after raw commands and restore a usable selected page without
   * adopting ambient user tabs. */
  private async reconcileExternalPages(): Promise<void> {
    const epoch = this.captureRunPageOwnershipEpoch();
    if (this.context.isClosed()) {
      throw new Error(
        'External browser commands closed the browser session; replacing it mid-run is unsupported.',
      );
    }

    let livePages: Page[];
    try {
      livePages = this.context.pages();
    } catch {
      throw new Error(
        'External browser commands left the browser session unusable; replacing it mid-run is unsupported.',
      );
    }

    for (const page of livePages) {
      if (
        this.preexistingSessionPages.has(page) ||
        this.ownedPages.has(page) ||
        !(await this.hasOwnershipEvidence(page, epoch))
      ) {
        continue;
      }
      await this.claimDurablyOwnedPage(page, epoch);
    }

    if (this.activePage !== undefined && !this.activePage.isClosed()) return;

    const liveTrackedPage = [...this.trackedPages.values()].find(
      (record) => !record.page.isClosed(),
    )?.page;
    if (liveTrackedPage !== undefined) {
      this.activePage = liveTrackedPage;
      return;
    }

    try {
      if (epoch.marker === undefined) {
        throw new Error('durable ownership is not initialized');
      }
      await this.openDurableTaskTarget({});
    } catch {
      throw new Error(
        'External browser commands left the browser session unusable; replacing it mid-run is unsupported.',
      );
    }
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
    const outcome = await settleWithin(closing, BROWSER_PREPARATION_CONTAINMENT_TIMEOUT_MS);
    if (outcome === 'timed_out' && !page.isClosed()) {
      // The outer coordinator checks this exact exclusive fence before any
      // terminal cleanup or checkpoint. A close that never acknowledges
      // therefore leaves the active checkpoint resumable instead of racing a
      // terminal projection.
      this.busyRegistry?.markAbandoned(closing);
    }
  }

  private requirePreparationBusyRegistry(signal: AbortSignal | undefined): void {
    if (signal !== undefined && this.busyRegistry === undefined) {
      throw new Error(
        'Cancellation-safe browser preparation requires a shared busy-resource registry.',
      );
    }
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
    // requirePage(), whose "No browser task page is active" reads as a
    // recoverable state and invites a retry against a
    // browser that no longer exists. Measured: after a session timed out
    // mid-run, an agent alternated navigate/sleep for ~20 turns and would
    // have continued indefinitely (worker turns are unbounded by default).
    //
    // Phrased so isBrowserDeathMessage() recognizes it, which routes the TUI
    // into its existing relaunch path — for a remote provider, a fresh session
    // on the persisted Context.
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
      // Durable target preparation may have claimed this exact page while the
      // asynchronous opener/marker check above was in flight. Re-check before
      // installing the marker: a second renderer evaluation can otherwise
      // become trapped behind a dialog opened immediately after preparation.
      if (this.ownedPages.has(page)) return;
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
      throw new Error('A raw browser target completed after its task-page ownership epoch ended.');
    }
    this.pendingOwnedTargetIds.set(targetId, epoch.generation);
    const deadline = Date.now() + RAW_TARGET_PAGE_APPEAR_TIMEOUT_MS;
    for (;;) {
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
          if (this.ownedPages.has(page)) return;
          await this.claimDurablyOwnedPage(page, epoch);
          return;
        }
      }
      if (Date.now() >= deadline) return;
      // Target.createTarget answers before Playwright is guaranteed to have
      // emitted/registered the matching Page. Give that independent protocol
      // event a short bounded window instead of turning ordinary delivery
      // skew into a false unresolved-target failure at refresh.
      await delay(RAW_TARGET_PAGE_POLL_MS);
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
      [...this.pendingOwnedTargetIds.values()].some((generation) => generation === epoch.generation)
    ) {
      const targetId = await this.targetIdForPage(page);
      if (targetId !== undefined && this.pendingOwnedTargetIds.get(targetId) === epoch.generation) {
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
  private targetIdForPage(page: Page): Promise<string | undefined> {
    return resolvePageTarget(this.context, page, { failureMode: 'silent' });
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
  private claimDurablyOwnedPage(
    page: Page,
    epoch: RunPageOwnershipEpoch = this.captureRunPageOwnershipEpoch(),
  ): Promise<PageRecord> {
    const existing = this.durablePageClaims.get(page);
    if (existing !== undefined) return existing;

    const claim = this.claimDurablyOwnedPageOnce(page, epoch);
    this.durablePageClaims.set(page, claim);
    void claim.then(
      () => this.durablePageClaims.delete(page),
      () => this.durablePageClaims.delete(page),
    );
    return claim;
  }

  private async claimDurablyOwnedPageOnce(
    page: Page,
    epoch: RunPageOwnershipEpoch,
  ): Promise<PageRecord> {
    if (!this.isCurrentRunPageOwnershipEpoch(epoch)) {
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      throw new Error('Task-page ownership changed before the page could be claimed.');
    }
    try {
      await markPageWithRunOwnership(page, epoch.marker);
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
      throw new Error('Crash-recoverable browser target control is unavailable for this session.');
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
    this.pendingDialogs.delete(pending.info.dialogId);
    try {
      if (params.accept) {
        await pending.dialog.accept(
          typeof params.promptText === 'string' ? params.promptText : undefined,
        );
      } else {
        await pending.dialog.dismiss();
      }
    } finally {
      // A timed-out browser program can leave the command session attached
      // while its dialog blocks the renderer. Only the explicit decision may
      // release those detachers; detaching earlier silently dismisses it.
      await this.detachDeferredCommandSessions(pending.info.pageId);
    }
    return {};
  }

  private async releaseCommandSession(
    pageId: string,
    detach: () => Promise<void>,
    hadPendingCommands: boolean,
  ): Promise<void> {
    // Let Playwright deliver a dialog event queued by the just-completed CDP
    // message before deciding whether detaching would answer it implicitly.
    if (hadPendingCommands) await browserOwnershipEventTurn();
    else await Promise.resolve();
    const blocked = [...this.pendingDialogs.values()].some(
      (pending) => pending.info.pageId === pageId,
    );
    if (!blocked) {
      await detach();
      if (hadPendingCommands) {
        this.pagesWithAbandonedCommands.add(pageId);
      }
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

  private async retirePagesWithAbandonedCommands(): Promise<void> {
    for (const pageId of [...this.pagesWithAbandonedCommands]) {
      const record = this.recordByPageId(pageId);
      if (record === undefined || record.page.isClosed()) {
        this.pagesWithAbandonedCommands.delete(pageId);
        continue;
      }
      if (!this.ownedPages.has(record.page)) {
        throw new Error(
          'An abandoned browser command was attached to a page outside the current run.',
        );
      }

      let closeEffect: Promise<void>;
      try {
        closeEffect = record.page.close({ runBeforeUnload: false });
      } catch {
        throw new Error('Could not retire a page left busy by an abandoned browser command.');
      }
      const outcome = await settleWithin(closeEffect, ABANDONED_COMMAND_PAGE_CLOSE_TIMEOUT_MS);
      if (outcome === 'timed_out') {
        this.busyRegistry?.markAbandoned(closeEffect);
      }
      if (outcome !== 'fulfilled' || !record.page.isClosed()) {
        throw new Error('Could not retire a page left busy by an abandoned browser command.');
      }
      this.pagesWithAbandonedCommands.delete(pageId);
    }
  }

  /** Reach a bounded two-pass fixed point before an ownership epoch may end.
   * Each pass drains already-dispatched page events, inventories every live
   * non-user page with strict ownership checks, closes exact owned pages in
   * reverse order, and yields one event-loop turn. Two consecutive no-work
   * passes prove that closing an opener did not leave a queued popup claim. */
  private async closeOwnedPagesToFixedPoint(epoch: RunPageOwnershipEpoch): Promise<string[]> {
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
          const staleTargets = targets.filter((target) => target.url === sentinelUrl);
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
            errors.push(`${closeFailures} exact task target(s) could not be closed`);
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
        errors.push(`${this.ownedPages.size} task page(s) remained live after cleanup`);
      }
      const pendingTargets = this.pendingTargetCount(epoch);
      if (pendingTargets > 0) {
        errors.push(`${pendingTargets} exact task target(s) remained unresolved after cleanup`);
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

  private isCurrentRunPageOwnershipEpoch(epoch: RunPageOwnershipEpoch): boolean {
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

  /** Assign stable run-local identity and retain only lifecycle state the runtime uses. */
  private registerPage(page: Page): PageRecord {
    const existing = this.trackedPages.get(page);
    if (existing !== undefined) return existing;

    const record: PageRecord = {
      pageId: `page-${++this.pageSequence}`,
      page,
    };
    this.trackedPages.set(page, record);
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
    });
    page.on('close', () => {
      this.trackedPages.delete(page);
      this.ownedPages.delete(page);
      this.pagesWithAbandonedCommands.delete(record.pageId);
      for (const [dialogId, pending] of this.pendingDialogs) {
        if (pending.info.pageId === record.pageId) {
          this.pendingDialogs.delete(dialogId);
        }
      }
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      void this.detachDeferredCommandSessions(record.pageId);
    });
    return record;
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

  private describePage(record: PageRecord): BrowserPage {
    return {
      pageId: record.pageId,
      url: record.page.url(),
      active: this.activePage === record.page && !record.page.isClosed(),
    };
  }

  private requirePage(): Page {
    this.requireOpenContext();
    const page = this.activePage;
    if (page === undefined || page.isClosed()) {
      this.activePage = undefined;
      throw new Error('No browser task page is active; prepare the task page first.');
    }

    return page;
  }

  private requireNoActiveTaskPage(): void {
    if (this.activePage !== undefined && !this.activePage.isClosed()) {
      throw new Error('A browser task page is already active; close it first.');
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
      this.busyRegistry?.markAbandoned(effect);
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
   * Resolve the page an implicit-page-or-explicit-`pageId` method
   * (screenshot, download, or currentUrl) should act on.
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

/** Map Playwright's dialog type string onto the reported union. Unknown
 * types are reported as `alert`: the caller's only real decision is
 * accept/dismiss, and an unmapped type must not break the result. */
function normalizeDialogType(type: string): BrowserDialog['type'] {
  return type === 'confirm' || type === 'prompt' || type === 'beforeunload' ? type : 'alert';
}

function rawTargetCreationUrl(params: Record<string, unknown>): string {
  if (
    Object.keys(params).length !== 1 ||
    typeof params.url !== 'string' ||
    params.url.length === 0 ||
    Buffer.byteLength(params.url, 'utf8') > MAX_RAW_TARGET_URL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(params.url)
  ) {
    throw new TypeError('Run-owned Target.createTarget accepts exactly one bounded URL parameter.');
  }
  try {
    new URL(params.url);
  } catch {
    throw new TypeError('Run-owned Target.createTarget requires an absolute URL.');
  }
  return params.url;
}

/** Browser startup cannot trust a provider promise to observe cancellation:
 * every preparation step races through {@link raceWithAbortContainment}, whose
 * containment-before-abort-rejection ordering is the load-bearing part. */
const raceBrowserPreparationStep = raceWithAbortContainment;

function browserOwnershipEventTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
