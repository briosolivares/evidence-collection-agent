// Type-only import: `browserActions.ts` imports BrowserRefNotFoundError
// (a runtime value) from this module, so the dependency between the two
// must stay one-directional at runtime. Keep this `import type`.
import type {
  BrowserJavaScriptResult,
  EarlyJavaScriptRequest,
} from './browserJavaScript.js';
import type {
  BrowserActionOutput,
  BrowserActionRequest,
  BrowserDialog,
} from './browserActions.js';
import type {
  BrowserObservation,
  BrowserObserveRequest,
  BrowserPage,
} from './browserState.js';

/** Options controlling a browser screenshot. */
export interface BrowserScreenshotOptions {
  /** Capture the entire scrollable page instead of only the viewport. */
  fullPage?: boolean;
}

/** An HTTP response fetched through the browser session. */
export interface BrowserFetchResult {
  /** HTTP response status code. */
  status: number;
  /** Response headers, keyed case-insensitively using lower-case names. */
  headers: Readonly<Record<string, string>>;
  /** Complete response body. */
  bytes: Uint8Array;
}

/** A resource captured through an actual browser page or download event. */
export interface BrowserDownloadResult {
  /** Final resource URL after redirects, or a browser-generated blob URL. */
  finalUrl: string;
  /** HTTP status when the capture came from a navigation response. */
  status?: number;
  /** Response headers when available, keyed using lower-case names. */
  headers: Readonly<Record<string, string>>;
  /** Complete downloaded response bytes. */
  bytes: Uint8Array;
  /** Browser-provided filename for attachment/download-event captures. */
  suggestedFilename?: string;
}

/** A browser-native download source: an observed page ref or verified URL. */
export type BrowserDownloadTarget = { ref: string } | { url: string };

/** How to answer one pending JavaScript dialog. */
export interface HandleDialogRequest {
  /** Dialog id from a `browser_action` result. */
  dialogId: string;
  /** `accept` presses OK (and submits `promptText` for a prompt);
   * `dismiss` presses Cancel. */
  action: 'accept' | 'dismiss';
  /** Text to submit when accepting a `prompt`; ignored for other types. */
  promptText?: string;
}

/** The outcome of answering one dialog. */
export interface HandleDialogResult {
  dialogId: string;
  handled: 'accepted' | 'dismissed';
  /** The page after the dialog was answered, absent when answering closed
   * or destroyed it (a `beforeunload` accept can do exactly that). */
  page?: BrowserPage;
  /** Dialogs still awaiting a decision, across the session. */
  pendingDialogs: BrowserDialog[];
}

/** What text to capture: a whole page, or one element observed on it. */
export interface BrowserTextCaptureRequest {
  /** Page to capture from; omitted means the selected page. */
  pageId?: string;
  /** Element id from a prior observation; omitted captures the whole page. */
  elementId?: string;
}

/**
 * Exactly what was read, and what it was read from. Every field is part of
 * the evidence record the capture produces: without page and document
 * identity, a captured string cannot be traced back to the thing that
 * rendered it.
 */
export interface BrowserCapturedText {
  /** The text exactly as rendered — no normalization, no truncation. */
  text: string;
  /** URL of the document the text came from. */
  url: string;
  /** Title of that document. */
  title: string;
  /** Stable page id the text came from. */
  pageId: string;
  /** Document id at capture time; a later rotation means the source is
   * gone, which is why it is recorded rather than inferred. */
  documentId: string;
  /** The page's observation number at capture time, when known. */
  observationId?: number;
  /** Engine-resolvable locator of what was read ('body' for a whole page).
   * This is the part that makes a capture reproducible. */
  locator: string;
}

/**
 * What a browser-script run needs to attach a SECOND, independent Playwright
 * client to the SAME running Chrome and the SAME selected tab a session's
 * ordinary browser tools are already using.
 */
export interface BrowserScriptSetup {
  /** Loopback CDP HTTP endpoint (e.g. `http://127.0.0.1:54213`) the
   * secondary client connects to via `chromium.connectOverCDP`. */
  cdpUrl: string;
  /** CDP target id of the currently selected page, so the secondary client
   * can find that exact tab among possibly several open ones — and must
   * never fall back to guessing (e.g. "the first page"). */
  selectedPageTargetId: string;
}

/** Error raised when a ref from an outline no longer identifies an element. */
export class BrowserRefNotFoundError extends Error {
  /** Ref that could not be resolved. */
  readonly ref: string;

  constructor(ref: string) {
    super(`Browser ref ${ref} is unavailable; inspect the page again before acting.`);
    this.name = 'BrowserRefNotFoundError';
    this.ref = ref;
  }
}

/**
 * Engine-neutral control surface for one browser session.
 *
 * A session owns at most one task tab at a time. Calling {@link newTab}
 * starts a run with a fresh page; calling {@link closeTab} ends that run
 * without closing the underlying browser session or its shared state.
 */
export interface BrowserController {
  /**
   * Open a fresh blank tab for a task run.
   *
   * @returns nothing; a new active tab whose URL is `about:blank` is ready
   *   for browser operations. Rejects if a task tab is already active.
   */
  newTab(): Promise<void>;

  /**
   * Close the active task tab while keeping the browser session alive.
   *
   * @returns nothing; after resolution no task tab is active. Calling this
   *   when no task tab is active is a no-op.
   */
  closeTab(): Promise<void>;

  /**
   * Navigate the active task tab to a URL.
   *
   * @param url - absolute HTTP or HTTPS URL to load
   * @returns nothing; the active tab has reached its load event, including
   *   any redirects, before the promise resolves
   */
  goto(url: string): Promise<void>;

  /**
   * Capture an AI-oriented semantic outline of the active page.
   *
   * @returns a YAML accessibility snapshot covering the full loaded page,
   *   with interactive elements annotated by refs. Consecutive calls on an
   *   unchanged page preserve refs, and returned refs can be passed to the
   *   ref-based methods on this controller.
   */
  outline(): Promise<string>;

  /**
   * Click the element identified by a ref from the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @returns nothing; the click has completed. Rejects with
   *   {@link BrowserRefNotFoundError} when the ref is invalid or stale.
   */
  click(ref: string): Promise<void>;

  /**
   * Replace an editable element's value using a ref from the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @param text - complete text value to place in the element
   * @returns nothing; the value has been filled. Rejects with
   *   {@link BrowserRefNotFoundError} when the ref is invalid or stale.
   */
  type(ref: string, text: string): Promise<void>;

  /**
   * Scroll the active page downward by approximately one viewport height.
   *
   * @returns nothing; the page has been scrolled before resolution
   */
  scroll(): Promise<void>;

  /**
   * Capture the active page as PNG bytes.
   *
   * @param options - optional viewport or full-page capture selection
   * @returns the complete PNG file bytes without writing an artifact
   */
  screenshot(options?: BrowserScreenshotOptions): Promise<Uint8Array>;

  /**
   * Resolve an element's link destination from a ref in the latest outline.
   *
   * @param ref - exact element ref returned by {@link outline}
   * @returns the absolute link URL, or null when the element has no href.
   *   Rejects with {@link BrowserRefNotFoundError} when the ref is invalid or
   *   stale.
   */
  resolveHref(ref: string): Promise<string | null>;

  /**
   * Fetch a URL through the browser session's request layer.
   *
   * @param url - absolute HTTP or HTTPS URL to request
   * @returns response status, headers, and complete bytes; browser cookies
   *   and session state are included, and non-success statuses still resolve
   */
  fetch(url: string): Promise<BrowserFetchResult>;

  /**
   * Capture a resource through Chrome's page network stack.
   *
   * HTTP(S) refs and URLs are opened in a temporary page so the active task
   * page remains unchanged; the main navigation response or resulting browser
   * download is captured exactly. Refs without an HTTP(S) href are clicked on
   * the active page and must trigger a browser download event.
   *
   * @param target - an inspected page ref or an absolute HTTP(S) URL
   * @returns exact bytes plus the final URL and available response metadata
   */
  download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult>;

  /**
   * Read the active task tab's current URL.
   *
   * @returns the absolute current URL, including the landed URL after a
   *   redirect. Throws when no task tab is active.
   */
  currentUrl(): string;

  /**
   * Read the active task tab's document title.
   *
   * @returns the current document title. Rejects when no task tab is active.
   */
  title(): Promise<string>;

  /**
   * List every tracked page (task tab and popups) with stable identity.
   *
   * @returns one {@link BrowserPage} per live tracked page, in tracking
   *   order. Internal throwaway pages (e.g. download capture pages) never
   *   appear. Listing never advances any page's observation id.
   */
  pages(): Promise<BrowserPage[]>;

  /**
   * Take a fresh snapshot of a page in the requested representations.
   *
   * @param request - page selection, requested needs, and an optional diff
   *   baseline; omitted entirely means an interactive snapshot of the
   *   selected page
   * @returns the new observation: the page (with its incremented
   *   observation id), one bounded view per need, the observed elements,
   *   and changes vs the requested baseline. An evicted or unknown
   *   baseline degrades to `basis: 'full_snapshot'` — never an error.
   */
  observe(request?: BrowserObserveRequest): Promise<BrowserObservation>;

  /**
   * Execute a short action sequence against one page and document,
   * returning a receipt per attempted action.
   *
   * @param request - page/document preconditions, 1–8 ordered actions,
   *   optional success checks, settle overrides, and the run directory that
   *   confines upload paths
   * @returns what actually happened: one receipt per attempted action with
   *   `effectsCommitted`, the first unexecuted index and stop reason when
   *   the sequence stopped at a navigation/popup/dialog/failure, the
   *   settle and success-check outcomes, and the resulting page with
   *   bounded changes. Committed effects are never rolled back, so a failed
   *   success check returns `failed_check` rather than implying the page is
   *   unchanged. Rejects only when the request cannot be aimed at a page at
   *   all (unknown page id, closed session)
   */
  browserAction(request: BrowserActionRequest): Promise<BrowserActionOutput>;

  /**
   * Answer one JavaScript dialog that is blocking a page.
   *
   * Dialogs are held open rather than auto-dismissed, because silently
   * dismissing a `confirm` decides the user's business for them. While one
   * is pending its page runs no script, so this is the only way forward.
   *
   * @param request - the dialog id, accept/dismiss, and prompt text
   * @returns the decision, the page afterwards when it survives, and any
   *   dialogs still pending. Rejects when the id names no pending dialog
   *   (already answered, or its page closed)
   */
  handleDialog(request: HandleDialogRequest): Promise<HandleDialogResult>;

  /**
   * Select a tracked page as the target of the single-page methods
   * (goto/outline/click/type/...) — how legacy tools reach a popup.
   *
   * @param pageId - a page id from {@link pages} or an observation
   * @returns the selected page's current state with `active: true`.
   *   Rejects when the id names no live tracked page.
   */
  switchPage(pageId: string): Promise<BrowserPage>;

  /**
   * Close the browser session and every page it owns.
   *
   * @returns nothing; all browser resources are released. Repeated calls are
   *   safe and no later browser operation may succeed.
   */
  /**
   * Evaluate a snippet in the selected page's top document (T6).
   *
   * OPTIONAL on purpose: a session may legitimately not offer page JavaScript
   * (an authenticated lane configured `deny`, or a stub in a test that never
   * needs it). A run wires the `execute_javascript` tool only when the session
   * provides this, so an absent capability is an omitted tool rather than a
   * tool that fails at call time.
   *
   * Every call is a page WRITE — the snippet can mutate the DOM — so it must
   * never be scheduled as a read.
   *
   * @throws BrowserJavaScriptTimeoutError when the hard deadline is exceeded.
   *   Terminal: a spinning snippet cannot be interrupted, so the caller must
   *   call replaceUnresponsivePage rather than retry into the same page
   * @throws BrowserJavaScriptNonJsonError when the completion value cannot
   *   cross the boundary as JSON
   */
  executeJavaScript?(request: EarlyJavaScriptRequest): Promise<BrowserJavaScriptResult>;

  /** Discard a page whose JavaScript could not be terminated and select a
   * replacement, invalidating that document's refs and observations (T6).
   * Present exactly when executeJavaScript is. */
  replaceUnresponsivePage?(): Promise<void>;

  /**
   * Read a page's, or one observed element's, exact rendered text for
   * capture as evidence (T11).
   *
   * Distinct from {@link observe}'s text view on purpose: that view is
   * normalized and cut at a per-view bound, and a quotation cut
   * mid-sentence is precisely what a capture exists to prevent. This
   * returns the rendered text whole, plus the identity needed to re-read it
   * later.
   *
   * OPTIONAL for the same reason executeJavaScript is: a run wires
   * `capture_text` only when the session provides this, so a session that
   * cannot capture omits the tool instead of offering one that fails when
   * called.
   *
   * @param request - page and optional element selection
   * @returns the text plus the identity of what produced it
   * @throws BrowserRefNotFoundError when `elementId` names no element in a
   *   retained observation of that page, or its document has been replaced
   */
  captureText?(request?: BrowserTextCaptureRequest): Promise<BrowserCapturedText>;

  /**
   * Prepare this session to be driven by an external browser script: a
   * short-lived process that opens its OWN Playwright connection to the SAME
   * running Chrome over CDP, so it can act on the exact tab this controller
   * currently has selected.
   *
   * OPTIONAL, and a PAIRED capability with {@link refreshAfterBrowserScript}:
   * a controller implements both or neither. {@link
   * assertBrowserScriptSupportIsPaired} enforces that once, at session
   * startup, so a provider that wired only one half fails loudly as a
   * configuration error instead of surprising a caller mid-run when the
   * missing half is finally needed. A controller with no CDP endpoint at all
   * (a remote provider, a stub in a test) simply omits both, and a run wires
   * the browser-script tool only when both are present — the same pattern
   * {@link executeJavaScript} and {@link replaceUnresponsivePage} use.
   *
   * This is an idempotent READ, not a stateful lease: it hands back facts
   * the secondary client needs (where the browser is, which tab to use) and
   * records no reservation anywhere. There is deliberately no lease object,
   * capability token, or "owns the browser now" handshake to release later —
   * the scheduler's own exclusivity already guarantees no other browser tool
   * runs concurrently with a script, so nothing here needs to enforce that a
   * second time. Calling it again before {@link refreshAfterBrowserScript}
   * runs is safe and returns the current facts.
   *
   * @returns the CDP endpoint and the selected page's CDP target id
   * @throws Error when no task tab is currently active, or this controller
   *   has no CDP endpoint configured
   */
  prepareForBrowserScript?(): Promise<BrowserScriptSetup>;

  /**
   * Reconcile this controller's state after an external browser script has
   * run and exited. Nothing about a script's actions is rolled back — this
   * only makes sure nothing here still trusts state the script may have
   * invalidated (a mutated DOM, a closed tab, a popup it opened).
   *
   * OPTIONAL, and PAIRED with {@link prepareForBrowserScript} — see there for
   * why half-implemented support is rejected rather than tolerated.
   *
   * Like {@link prepareForBrowserScript}, this is an idempotent REFRESH, not
   * the release side of a lease: there was never a lease to release, only
   * facts that may now be stale. Calling it again when nothing changed is a
   * no-op beyond another conservative invalidation pass.
   *
   * @throws Error when the script closed the entire browser/context.
   *   Recreating a session mid-run is out of scope: every later browser tool
   *   stays unavailable for the rest of this run.
   */
  refreshAfterBrowserScript?(): Promise<void>;

  close(): Promise<void>;
}

/**
 * Verify a controller implements both {@link BrowserController.prepareForBrowserScript}
 * and {@link BrowserController.refreshAfterBrowserScript}, or neither.
 *
 * Meant to be called once, at session startup, by whatever owns the
 * controller and decides which tools a run gets. Half-implemented support —
 * a provider that wired one method but not its pair — is a configuration
 * error the owner should learn about immediately, not a runtime surprise the
 * first time a browser script tries to refresh state that was never
 * prepared (or vice versa).
 *
 * @param controller - the controller to check
 * @throws Error when exactly one of the two methods is present
 */
export function assertBrowserScriptSupportIsPaired(controller: BrowserController): void {
  const hasPrepare = typeof controller.prepareForBrowserScript === 'function';
  const hasRefresh = typeof controller.refreshAfterBrowserScript === 'function';
  if (hasPrepare === hasRefresh) {
    return;
  }
  throw new Error(
    'Browser script support is half-implemented on this controller: ' +
      `${hasPrepare ? 'prepareForBrowserScript is present but refreshAfterBrowserScript is not' : 'refreshAfterBrowserScript is present but prepareForBrowserScript is not'}. ` +
      'A controller must implement both methods or neither.',
  );
}
