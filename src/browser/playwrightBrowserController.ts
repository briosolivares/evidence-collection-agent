import { isAbsolute } from 'node:path';

import {
  chromium,
  type BrowserContext,
  type Download,
  type Frame,
  type Locator,
  type Page,
  type Response,
} from 'playwright';

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
} from './controller.js';
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
/** Main-frame aria refs (`e12`). Subframe refs (`f1e12`) are skipped for
 * element identity until T11's targeted observation; frame identity itself
 * is already tracked through frame events. */
const MAIN_FRAME_ARIA_REF_PATTERN = /^e\d+$/;
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
    });
    page.on('framedetached', (frame) => {
      record.frames.delete(frame);
    });
    page.on('close', () => {
      this.trackedPages.delete(page);
      this.state.forgetPage(record.pageId);
      if (this.activePage === page) {
        this.activePage = undefined;
      }
    });

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
      // Mid-navigation the title evaluation can fail; '' beats failing the
      // whole listing.
      title: await page.title().catch(() => ''),
      active: this.activePage === page && !page.isClosed(),
      frames,
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
      if (!MAIN_FRAME_ARIA_REF_PATTERN.test(entry.ariaRef)) {
        continue;
      }
      let id: string;
      try {
        // The attribute name travels as an argument rather than being
        // inlined in the page function: resolution reads the marker through
        // ELEMENT_MARKER_ATTRIBUTE, and a hardcoded copy here would silently
        // stamp the old name (every ref instantly stale) if it ever changed.
        id = await record.page.locator(`aria-ref=${entry.ariaRef}`).evaluate(
          (element, { attribute, proposedId }) => {
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
        // The element vanished between snapshot and stamping; observation
        // stays best-effort rather than failing wholesale.
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
