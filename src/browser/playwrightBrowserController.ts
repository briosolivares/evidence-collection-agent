import { isAbsolute } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Dialog,
  type Download,
  type Frame,
  type Locator,
  type Page,
  type Response,
} from 'playwright';

import {
  performBrowserActions,
  type ActionCapableSession,
  type ActionTargetHandle,
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
  type BrowserFrame,
  type BrowserObservation,
  type BrowserObserveRequest,
  type BrowserPage,
  type BrowserStateStore,
  type ElementRef,
  type ObservationNeed,
  type ObservationView,
} from './browserState.js';
import {
  BrowserRefNotFoundError,
  type BrowserController,
  type BrowserDownloadResult,
  type BrowserDownloadTarget,
  type BrowserFetchResult,
  type BrowserScreenshotOptions,
  type HandleDialogRequest,
  type HandleDialogResult,
} from './controller.js';
import {
  BrowserJavaScriptNonJsonError,
  BrowserJavaScriptTimeoutError,
  type BrowserJavaScriptResult,
  type EarlyJavaScriptRequest,
} from './browserJavaScript.js';
import type { BrowserSessionProvider } from './sessionProvider.js';

const ARIA_REF_PATTERN = /^(?:f\d+)?e\d+$/;
const DOWNLOAD_EVENT_TIMEOUT_MS = 5_000;
const DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS = 1_000;
const SCROLL_SETTLE_MS = 50;

// --- T9 observation bounds (all finite literals). ---
/** Elements stamped per interactive observation; the outline itself still
 * lists everything, this only bounds per-element identity work. */
const MAX_OBSERVED_ELEMENTS = 150;
/** Per-view content bound so an evicted-baseline "full snapshot" stays
 * bounded even before the tool pipeline's byte cap. */
const MAX_VIEW_CONTENT_CHARS = 60_000;
/* Element identity is limited to the page's TOP document until T11 adds
 * targeted per-frame observation — a subframe element stamped with the main
 * frame's frameId/documentId would go stale for the wrong reason. The test
 * is made *in the page* (see stampOutlineElements) rather than from the ref's
 * syntax: Playwright prefixes refs with a frame ordinal (`f1e8`) once the
 * page has navigated more than once, so a "bare `e12` means main frame"
 * rule silently drops every element on any page reached by two navigations,
 * which is precisely the page an action sequence lands on. */
/** The attribute stamped on observed elements. It is the ref's exact-node
 * identity within its document: DOM moves and unrelated mutation keep it,
 * document replacement destroys it. */
const ELEMENT_MARKER_ATTRIBUTE = 'data-sherlock-el';
/** Element ids are store-issued (`el-7`); enforcing the shape keeps the
 * marker CSS selector injection-proof even for a crafted ref. */
const ELEMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Roles worth element identity for the `interactive` need. The outline
 * shows every visible node; only action targets need durable refs. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
]);
// --- T10 action bounds (all finite literals). ---
/** Per-element-action deadline. Far below Playwright's 30s default: a
 * sequence of eight actions must not be able to hold a turn for minutes,
 * and an element that is not actionable within five seconds is better
 * reported than waited on. */
const ACTION_TIMEOUT_MS = 5_000;
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

/** One outline entry: `- role "name" ... [ref=e12]` (name optional). */
const OUTLINE_ELEMENT_PATTERN =
  /^\s*-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*?\[ref=([A-Za-z0-9]+)\]/;

/** Runtime tracking for one page: its stable id plus per-frame records. */
interface PageRecord {
  pageId: string;
  page: Page;
  /** Keyed by the live Playwright Frame — Playwright reuses the same Frame
   * object across navigations, so the key survives exactly as long as the
   * frame's identity should. */
  frames: Map<Frame, FrameRecord>;
  /** Main-frame document replacements seen so far. Monotonic; a
   * {@link PageWatch} reads the delta rather than the absolute value. */
  navigationCount: number;
  /** Downloads this page started, oldest first, bounded. */
  downloads: DownloadInfo[];
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
  return chromium.launchPersistentContext(options.profileDir, {
    ...(options.executablePath !== undefined
      ? { executablePath: options.executablePath }
      : { channel: 'chrome' }),
    headless: options.headless ?? false,
  });
}

/** Creates persistent local Chrome sessions controlled through Playwright. */
export class LocalChromeBrowserSessionProvider implements BrowserSessionProvider {
  constructor(private readonly options: LocalChromeBrowserSessionOptions) {}

  async createSession(): Promise<BrowserController> {
    const context = await launchPersistentChrome(this.options);

    try {
      await prepareSessionPage(context);
      return new PlaywrightBrowserController(context);
    } catch (error) {
      await context.close();
      throw error;
    }
  }
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
  /** Sequence-scoped watchers subscribed to page activity (navigations,
   * new pages, dialogs, downloads). */
  private readonly activityListeners = new Set<() => void>();
  private dialogSequence = 0;

  constructor(
    private readonly context: BrowserContext,
    stateStore: BrowserStateStore = createBrowserStateStore(),
  ) {
    this.state = stateStore;
    // Track every page the browser creates. Task tabs register themselves in
    // newTab() (registerPage dedupes), so the pages that reach registerPage
    // *only* through this listener are popups — including `noopener` popups,
    // whose `page.opener()` is null and which a per-page 'popup' listener
    // could miss.
    this.context.on('page', (page) => {
      if (this.pendingInternalPages > 0) {
        this.pendingInternalPages -= 1;
        return;
      }
      this.registerPage(page);
    });
  }

  newTab(): Promise<void> {
    return this.serializeTabLifecycle(async () => {
      this.requireOpenContext();
      if (this.activePage !== undefined && !this.activePage.isClosed()) {
        throw new Error('A browser task tab is already active; close it first.');
      }

      const page = await this.context.newPage();
      // The context listener normally registered it already; this is the
      // dedupe-safe guarantee that a task tab is tracked.
      this.registerPage(page);
      this.activePage = page;
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

  async goto(url: string): Promise<void> {
    assertHttpUrl(url);
    await this.requirePage().goto(url, { waitUntil: 'load' });
  }

  async outline(): Promise<string> {
    return this.requirePage().ariaSnapshot({ mode: 'ai' });
  }

  async click(ref: string): Promise<void> {
    const locator = await this.locatorForRef(ref);
    try {
      await locator.click();
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
  }

  async type(ref: string, text: string): Promise<void> {
    const locator = await this.locatorForRef(ref);
    try {
      await locator.fill(text);
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
  }

  async scroll(): Promise<void> {
    const page = this.requirePage();
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(SCROLL_SETTLE_MS);
  }

  async screenshot(
    options: BrowserScreenshotOptions = {},
  ): Promise<Uint8Array> {
    const bytes = await this.requirePage().screenshot({
      fullPage: options.fullPage ?? false,
      type: 'png',
    });
    return new Uint8Array(bytes);
  }

  async resolveHref(ref: string): Promise<string | null> {
    const locator = await this.locatorForRef(ref);
    try {
      return await locator.evaluate((element) => {
        const href = element.getAttribute('href');
        return href === null
          ? null
          : new URL(href, element.ownerDocument.baseURI).href;
      });
    } catch (error) {
      throw await normalizeRefActionError(locator, ref, error);
    }
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

    if ('url' in target) {
      assertHttpUrl(target.url);
      return this.captureUrlThroughChrome(target.url);
    }

    const locator = await this.locatorForRef(target.ref);
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
      return this.captureUrlThroughChrome(href);
    }

    return this.captureClickDownload(locator, target.ref);
  }

  currentUrl(): string {
    return this.requirePage().url();
  }

  async title(): Promise<string> {
    return this.requirePage().title();
  }

  async pages(): Promise<BrowserPage[]> {
    this.requireOpenContext();
    const liveRecords = [...this.trackedPages.values()].filter(
      (record) => !record.page.isClosed(),
    );
    return Promise.all(liveRecords.map((record) => this.describePage(record)));
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
        const outline = await page.ariaSnapshot({ mode: 'ai' });
        elements = await this.stampOutlineElements(
          record,
          mainFrameRecord.frameId,
          documentId,
          outline,
        );
        views.push(makeBoundedView('interactive', outline));
      } else {
        // Exact rendered text (innerText respects visibility and layout),
        // for quotation-grade reads the outline normalizes away.
        const text = await page.evaluate(() => document.body?.innerText ?? '');
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
    return { page: await this.describePage(record), views, elements, changes };
  }

  switchPage(pageId: string): Promise<BrowserPage> {
    // Serialized with newTab/closeTab/close so page selection cannot race
    // a tab lifecycle transition.
    return this.serializeTabLifecycle(async () => {
      this.requireOpenContext();
      const record = this.recordByPageId(pageId);
      if (record === undefined || record.page.isClosed()) {
        throw new Error(`Unknown or closed browser pageId: ${pageId}`);
      }
      this.activePage = record.page;
      return this.describePage(record);
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

    if (request.action === 'accept') {
      await pending.dialog.accept(request.promptText);
    } else {
      await pending.dialog.dismiss();
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
   * Resolution ladder: (1) the exact node via the marker stamped at
   * observation time — survives reorders and unrelated DOM mutation within
   * the same document; (2) a unique role/name match in the ref's document.
   * A saved ordinal is deliberately NEVER used to retarget: after a list
   * reorder it would silently mutate the wrong row, the exact failure this
   * ladder exists to prevent.
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
    const frameEntry = [...record.frames.entries()].find(
      ([, frameRecord]) => frameRecord.frameId === ref.frameId,
    );
    if (frameEntry === undefined) {
      throw new BrowserRefNotFoundError(ref.id);
    }
    const [frame, frameRecord] = frameEntry;
    if (frameRecord.documentId !== ref.documentId || frame.isDetached()) {
      // The document the element lived in was replaced — stale by
      // definition, regardless of what similar elements now exist.
      throw new BrowserRefNotFoundError(ref.id);
    }

    if (ELEMENT_ID_PATTERN.test(ref.id)) {
      const stamped = frame.locator(`[${ELEMENT_MARKER_ATTRIBUTE}="${ref.id}"]`);
      if ((await countRefMatches(stamped)) === 1) {
        return stamped;
      }
    }

    // Marker gone (e.g. the page stripped attributes): fall back to a
    // role/name match only when it is unique in the document. An empty
    // name can never be unique enough for a mutating action.
    if (ref.name !== '') {
      const byRole = frame.getByRole(ref.role as Parameters<Frame['getByRole']>[0], {
        name: ref.name,
        exact: true,
      });
      if ((await countRefMatches(byRole)) === 1) {
        return byRole;
      }
    }

    throw new BrowserRefNotFoundError(ref.id);
  }

  /**
   * Evaluate a snippet in the selected page's top document (T6).
   *
   * The page is resolved ONCE, up front, so a navigation mid-call cannot move
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
    const page = this.requirePage();
    const logs: string[] = [];
    const onConsole = (message: { text(): string }): void => {
      // Bounded: a snippet that logs in a loop must not grow the result
      // without limit.
      if (logs.length < 100) logs.push(message.text());
    };
    page.on('console', onConsole);

    try {
      // The document's identity is read BEFORE evaluation and reported with
      // the result, so a mid-call navigation is visible rather than silent.
      const url = page.url();
      const documentToken = await page.evaluate(
        `(() => { const w = globalThis; w.__sherlockDoc ??= 'doc-' + Math.random().toString(36).slice(2, 10); return w.__sherlockDoc; })()`,
      );

      let value: unknown;
      try {
        // Expression semantics FIRST, statement semantics as the fallback.
        //
        // A braced arrow body discards its last expression, so wrapping every
        // snippet as `(() => { CODE })()` returned undefined for a bare
        // expression, for a self-invoking function, and for code ending in an
        // expression statement — every natural form. The only shape that
        // worked was a top-level `return`, which is illegal in a real script.
        // A live run made 15 calls and got 15 failures, including on
        // `document.querySelectorAll(...).length`.
        const sources = evaluationSources(request.code);
        for (let attempt = 0; attempt < sources.length; attempt += 1) {
          try {
            value = await this.raceEvaluation(page, sources[attempt]!, request.timeoutMs);
            break;
          } catch (error) {
            // Fall through to statement semantics ONLY on a syntax error:
            // that proves nothing executed, so re-running cannot repeat a
            // side effect. A runtime error means the snippet already ran, and
            // silently running it a second time could double-submit a form.
            const canRetry = attempt < sources.length - 1 && isSyntaxErrorLike(error);
            if (!canRetry) throw error;
          }
        }
      } catch (error) {
        if (error instanceof BrowserJavaScriptTimeoutError) throw error;
        if (isTimeoutLikeError(error)) throw new BrowserJavaScriptTimeoutError(request.timeoutMs);
        // A serialization failure from the engine becomes the typed non-JSON
        // error, so the model is told how to fix its snippet rather than
        // shown a Playwright internal.
        if (isSerializationError(error)) {
          throw new BrowserJavaScriptNonJsonError('value', 'not JSON-serializable');
        }
        throw error;
      }

      return {
        value,
        url,
        documentToken: typeof documentToken === 'string' ? documentToken : 'unknown',
        logs,
      };
    } finally {
      page.off('console', onConsole);
    }
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
    await this.serializeTabLifecycle(async () => {
      const doomed = this.activePage;
      this.activePage = undefined;
      if (doomed !== undefined) {
        // Best effort: a wedged page may refuse to close, and the run still
        // needs a usable page more than it needs a clean shutdown.
        await doomed.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      this.requireOpenContext();
      this.activePage = await this.context.newPage();
    });
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = this.serializeTabLifecycle(async () => {
      this.activePage = undefined;
      await this.context.close();
    });
    return this.closePromise;
  }

  private requireOpenContext(): void {
    if (this.closed) {
      throw new Error('Browser session is closed.');
    }
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
      while (record.downloads.length > MAX_TRACKED_DOWNLOADS_PER_PAGE) {
        record.downloads.shift();
      }
      this.signalActivity();
    });
    page.on('close', () => {
      this.trackedPages.delete(page);
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
    return this.buildPage(record, await record.page.title().catch(() => ''));
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
   * acting on a page never changes which page legacy tools target.
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
      resolveTarget: async (target) =>
        actionTargetHandle(await this.resolveElementRef(target)),
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
    const startDownloads = record.downloads.length;
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
      downloads: record.downloads.slice(startDownloads),
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

  /** Give every interactive outline entry durable identity: stamp (or
   * re-read) the marker attribute on the exact node behind each aria ref.
   * Stamping is write-once per node, so re-observing an unchanged document
   * returns the SAME element ids — that stability is what makes
   * observation diffs and cross-observation refs meaningful. */
  private async stampOutlineElements(
    record: PageRecord,
    frameId: string,
    documentId: string,
    outline: string,
  ): Promise<ElementRef[]> {
    const refs: ElementRef[] = [];
    const ordinals = new Map<string, number>();
    for (const entry of parseOutlineElements(outline).slice(0, MAX_OBSERVED_ELEMENTS)) {
      let id: string | null;
      try {
        // The attribute name travels as an argument rather than being
        // inlined in the page function: resolution reads the marker through
        // ELEMENT_MARKER_ATTRIBUTE, and a hardcoded copy here would silently
        // stamp the old name (every ref instantly stale) if it ever changed.
        id = await record.page.locator(`aria-ref=${entry.ariaRef}`).evaluate(
          (element, { attribute, proposedId }) => {
            // Top-document-only identity, decided by the document itself.
            const view = element.ownerDocument.defaultView;
            if (view === null || view !== view.top) {
              return null;
            }
            const existing = element.getAttribute(attribute);
            if (existing !== null) {
              return existing;
            }
            element.setAttribute(attribute, proposedId);
            return proposedId;
          },
          {
            attribute: ELEMENT_MARKER_ATTRIBUTE,
            proposedId: this.state.createElementId(),
          },
        );
      } catch {
        // The element vanished between snapshot and stamping (or lives in a
        // frame this page-scoped locator cannot reach); observation stays
        // best-effort rather than failing wholesale.
        continue;
      }
      if (id === null) {
        // An element inside a subframe: skipped, and its issued id is simply
        // never used (ids are unique, not contiguous).
        continue;
      }
      // A literal NUL separator cannot appear in a role or an accessible
      // name, so no `role`/`name` pair can collide with another; written
      // as an escape because a raw NUL byte makes this file binary to
      // grep and other text tooling.
      const ordinalKey = `${entry.role}\u0000${entry.name}`;
      const ordinal = ordinals.get(ordinalKey) ?? 0;
      ordinals.set(ordinalKey, ordinal + 1);
      refs.push({
        id,
        pageId: record.pageId,
        frameId,
        documentId,
        // backendNodeId deliberately unset: the stamped marker already
        // provides same-document exact-node identity without CDP coupling.
        stableLocator: `[${ELEMENT_MARKER_ATTRIBUTE}="${id}"]`,
        role: entry.role,
        name: entry.name,
        ordinal,
      });
    }
    return refs;
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

  private async captureUrlThroughChrome(url: string): Promise<BrowserDownloadResult> {
    const referringUrl = this.requirePage().url();
    // A throwaway plumbing page: counted out of the page registry (see the
    // constructor's 'page' listener) so pages() never shows it and no
    // identity is ever bound to it.
    this.pendingInternalPages += 1;
    let capturePage: Page;
    try {
      capturePage = await this.context.newPage();
    } catch (error) {
      // newPage failed before (or, vanishingly rarely, after) its 'page'
      // event; rebalance without going negative so a later popup cannot be
      // misclassified as internal.
      this.pendingInternalPages = Math.max(0, this.pendingInternalPages - 1);
      throw error;
    }

    try {
      const downloadOutcome = capturePage
        .waitForEvent('download', { timeout: 0 })
        .then((download) => ({ kind: 'download' as const, download }));
      const navigationOutcome = capturePage
        .goto(url, {
          waitUntil: 'commit',
          ...(isHttpUrl(referringUrl) ? { referer: referringUrl } : {}),
        })
        .then(
          (response) => ({ kind: 'response' as const, response }),
          (error: unknown) => ({ kind: 'navigation_error' as const, error }),
        );

      const outcome = await Promise.race([downloadOutcome, navigationOutcome]);
      if (outcome.kind === 'download') {
        return await readBrowserDownload(outcome.download);
      }

      if (outcome.kind === 'response') {
        if (outcome.response === null) {
          throw new Error(`Browser navigation produced no response: ${url}`);
        }
        return await readNavigationResponse(outcome.response);
      }

      const lateDownload = await Promise.race([
        downloadOutcome,
        delay(DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS).then(() => undefined),
      ]);
      if (lateDownload !== undefined) {
        return await readBrowserDownload(lateDownload.download);
      }
      throw outcome.error;
    } finally {
      await capturePage.close();
    }
  }

  private async captureClickDownload(
    locator: Locator,
    ref: string,
  ): Promise<BrowserDownloadResult> {
    const page = this.requirePage();
    const downloadPromise = page.waitForEvent('download', {
      timeout: DOWNLOAD_EVENT_TIMEOUT_MS,
    });
    void downloadPromise.catch(() => undefined);
    let clickCompleted = false;

    try {
      await locator.click();
      clickCompleted = true;
      return await readBrowserDownload(await downloadPromise);
    } catch (error) {
      if (!clickCompleted) {
        throw await normalizeRefActionError(locator, ref, error);
      }
      throw new Error(
        `Browser ref ${ref} has no HTTP(S) href and did not start a browser download. ` +
          'Re-run inspect_page and choose a download link or control, or pass a verified direct URL.',
      );
    }
  }

  private async locatorForRef(ref: string): Promise<Locator> {
    if (!ARIA_REF_PATTERN.test(ref)) {
      throw new BrowserRefNotFoundError(ref);
    }

    const locator = this.requirePage().locator(`aria-ref=${ref}`);
    if ((await countRefMatches(locator)) !== 1) {
      throw new BrowserRefNotFoundError(ref);
    }

    return locator;
  }

  private serializeTabLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tabLifecycle.then(operation);
    this.tabLifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
        const text = await page.evaluate(() => document.body?.innerText ?? '');
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

/** Wrap a revalidated locator as an action handle. Every op carries the
 * finite {@link ACTION_TIMEOUT_MS} instead of Playwright's 30s default. */
function actionTargetHandle(locator: Locator): ActionTargetHandle {
  const options = { timeout: ACTION_TIMEOUT_MS };
  return {
    click: () => locator.click(options),
    fill: (text) => locator.fill(text, options),
    press: (key) => locator.press(key, options),
    selectOptions: (values) => locator.selectOption([...values], options).then(() => undefined),
    setChecked: (checked) => locator.setChecked(checked, options),
    hover: () => locator.hover(options),
    setFiles: (absolutePaths) => locator.setInputFiles([...absolutePaths], options),
  };
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
  await page.evaluate(
    ({ unit, value, signum }) => {
      const distance = unit === 'viewport' ? window.innerHeight * value : value;
      window.scrollBy(0, distance * signum);
    },
    { unit: amount.unit, value: amount.value, signum: sign },
  );
  await page.waitForTimeout(SCROLL_SETTLE_MS);
}

/** Collect the evidence a blocked classification is drawn from. Bounded and
 * best-effort: an unreadable page yields empty signals (classified as "not
 * blocked") rather than failing the whole action result. */
async function collectBlockSignals(record: PageRecord): Promise<BlockSignals> {
  const page = record.page;
  const probe = await page
    .evaluate((maxChars) => {
      const text = document.body?.innerText ?? '';
      return {
        text: text.slice(0, maxChars),
        hasPasswordField: document.querySelector('input[type="password"]') !== null,
      };
    }, MAX_BLOCK_TEXT_CHARS)
    .catch(() => ({ text: '', hasPasswordField: false }));

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

async function prepareSessionPage(context: BrowserContext): Promise<void> {
  const pages = context.pages();
  const sessionPage = pages[0] ?? (await context.newPage());

  for (const extraPage of pages.slice(1)) {
    await extraPage.close();
  }

  if (sessionPage.url() !== 'about:blank') {
    await sessionPage.goto('about:blank');
  }
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

/** Parse the interactive entries out of an AI-mode aria snapshot: role,
 * unescaped accessible name, and the snapshot-scoped aria ref. Entries
 * whose role is not an action target (headings, generics, lists, ...) are
 * skipped — the outline text still shows them. */
function parseOutlineElements(
  outline: string,
): Array<{ role: string; name: string; ariaRef: string }> {
  const entries: Array<{ role: string; name: string; ariaRef: string }> = [];
  for (const line of outline.split('\n')) {
    const match = OUTLINE_ELEMENT_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const role = match[1] ?? '';
    if (!INTERACTIVE_ROLES.has(role)) {
      continue;
    }
    entries.push({
      role,
      // The snapshot backslash-escapes quotes inside names; undo that.
      name: (match[2] ?? '').replace(/\\(.)/g, '$1'),
      ariaRef: match[3] ?? '',
    });
  }
  return entries;
}

async function normalizeRefActionError(
  locator: Locator,
  ref: string,
  error: unknown,
): Promise<unknown> {
  if ((await countRefMatches(locator)) === 0) {
    return new BrowserRefNotFoundError(ref);
  }

  return error;
}

async function countRefMatches(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
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

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function readNavigationResponse(
  response: Response,
): Promise<BrowserDownloadResult> {
  const headers = response.headers();
  return {
    finalUrl: response.url(),
    status: response.status(),
    headers,
    bytes: new Uint8Array(await response.body()),
    ...(suggestedFilenameFromHeaders(headers) !== undefined
      ? { suggestedFilename: suggestedFilenameFromHeaders(headers) }
      : {}),
  };
}

async function readBrowserDownload(
  download: Download,
): Promise<BrowserDownloadResult> {
  const failure = await download.failure();
  if (failure !== null) {
    throw new Error(`Browser download failed: ${failure}`);
  }

  const stream = await download.createReadStream();
  if (stream === null) {
    throw new Error('Browser download completed without a readable byte stream.');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    finalUrl: download.url(),
    headers: {},
    bytes: new Uint8Array(Buffer.concat(chunks)),
    suggestedFilename: download.suggestedFilename(),
  };
}

function suggestedFilenameFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const disposition = headers['content-disposition'];
  if (disposition === undefined) return undefined;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      return encoded.trim();
    }
  }

  return disposition.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Whether an error is Playwright's evaluation timeout. Matched on message
 * because Playwright does not export a distinct timeout class for evaluate. */
function isTimeoutLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/timeout/i.test(error.message) || error.name === 'TimeoutError')
  );
}

/** Whether an error is the engine refusing to bring a value back as JSON. */
function isSerializationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /serializ|circular|convert|clone/i.test(error.message)
  );
}

/**
 * True for a parse failure, which is the one error class where re-running the
 * snippet under different wrapping is safe: a snippet that failed to parse
 * never executed, so it cannot have left a side effect behind.
 */
function isSyntaxErrorLike(error: unknown): boolean {
  return error instanceof Error && /SyntaxError|Unexpected (token|identifier|end)/i.test(
    error.message,
  );
}

/**
 * The wrappings to try for a model-supplied snippet, in order.
 *
 * 1. **Expression** — `return (CODE)`. Covers a bare expression
 *    (`document.title`) and a self-invoking function, the two forms a person
 *    writing a console one-liner reaches for first. A trailing semicolon is
 *    stripped because `return (x;)` will not parse.
 * 2. **Statement** — the raw body. Covers multi-statement code with an
 *    explicit top-level `return`, and is the only shape that can express
 *    early returns or declarations.
 *
 * Both are wrapped in an ASYNC arrow so `await` works at the snippet's top
 * level; Playwright resolves the returned promise before serializing, so a
 * synchronous snippet is unaffected.
 *
 * Deliberately no attempt to make a *statement body ending in an expression*
 * (`const x = 1; x;`) yield that expression: getting completion-value
 * semantics right needs a real parser, and guessing by rewriting the last
 * line would silently change what the model's code means. That form returns
 * undefined, and the error text names the two forms that work.
 */
export function evaluationSources(code: string): string[] {
  const expression = code.trim().replace(/;+$/, '');
  return [
    `(async () => { return (\n${expression}\n); })()`,
    `(async () => {\n${code}\n})()`,
  ];
}
