// Type-only, and the only Playwright reference in this otherwise
// backend-agnostic contract: `pdfPageSource` hands a real Playwright page
// factory to the PDF renderer, which drives an actual `Page`. Erased at
// runtime, so it adds no import edge; see `pdfPageSource` for why restating
// the shape by hand would be worse.
import type { Browser } from 'playwright';

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
// Type-only, erased at runtime — registry.ts already imports `type
// BrowserController` from this module, so this stays one-directional.
import type { BusyResourceRegistry } from '../tools/registry.js';
// Type-only: the diagnostics shape lives beside the provider seam that
// produces it, so a provider and the runtimes that read it agree on one
// definition. Erased at runtime — sessionProvider.ts imports this module.
import type { BrowserSessionDiagnostics } from './sessionProvider.js';

/** Options controlling a browser screenshot. */
export interface BrowserScreenshotOptions {
  /** Capture the entire scrollable page instead of only the viewport. */
  fullPage?: boolean;
  /** Page to capture; omitted means the selected page. */
  pageId?: string;
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

/** A browser-native download source: an observed page ref or verified URL.
 * `pageId` names which page to act on — the page the ref was observed on,
 * or the page whose context frames a direct URL fetch (a temporary page
 * still performs the actual capture regardless); omitted means the
 * selected page. */
export type BrowserDownloadTarget = { pageId?: string } & ({ ref: string } | { url: string });

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

/** Cancellation for task-page creation/navigation. Implementations must
 * contain any late browser effect before rejecting for an aborted signal: a
 * page created after rejection is closed automatically, and an interrupted
 * navigation cannot remain usable or race terminal cleanup. */
export interface BrowserOperationOptions {
  signal?: AbortSignal;
}

/** One v3-safe task-page startup transaction. `ownershipId` is harness-private
 * and `startUrl` is omitted for a blank task page. */
export interface BrowserTaskPagePreparation extends BrowserOperationOptions {
  ownershipId: string;
  startUrl?: string;
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
  /** CDP target id of the resolved page — the page named by
   * {@link BrowserController.prepareForBrowserScript}'s `pageId`, or the
   * selected page when it was omitted — so the secondary client can find
   * that exact tab among possibly several open ones — and must never fall
   * back to guessing (e.g. "the first page"). */
  selectedPageTargetId: string;
}

/**
 * One provider-neutral command channel pinned to one exact live browser page.
 *
 * The controller owns the underlying transport. Callers receive neither a
 * Playwright object nor the provider's CDP connection URL: only stable page
 * identity, Chrome target identity, and the ability to issue commands against
 * that already-attached target.
 */
export interface BrowserCommandSession {
  /** Stable controller identity of the page resolved when the session opened. */
  readonly pageId: string;
  /** Chrome target identity obtained from the same attached CDP session. */
  readonly targetId: string;
  /** Send one arbitrary Chrome DevTools Protocol command to this target. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Detach the underlying CDP session. Repeated calls are safe. */
  close(): Promise<void>;
}

/** Error raised when a ref from an outline no longer identifies an element. */
export class BrowserRefNotFoundError extends Error {
  /** Ref that could not be resolved. */
  readonly ref: string;

  /**
   * @param ref - the ref that could not be resolved
   * @param detail - why, for the cases where the default "inspect the page
   *   again" advice would be actively wrong. A ref that was never the right
   *   KIND of ref is not a stale one: re-observing hands back the same value,
   *   so the default guidance invites a loop. Written as a clause, without
   *   trailing punctuation.
   */
  constructor(ref: string, detail?: string) {
    super(
      detail === undefined
        ? `Browser ref ${ref} is unavailable; inspect the page again before acting.`
        : `Browser ref ${ref} is unusable: ${detail}.`,
    );
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
 *
 * The active tab is otherwise immutable for the run's whole life: nothing on
 * this interface moves the selected pointer away from the page {@link newTab}
 * opened, so every other page (a popup, a second tab) must be addressed
 * explicitly by `pageId` rather than selected first. An implementation may
 * still re-point the pointer when {@link refreshAfterBrowserScript} finds the
 * selected page closed out from under it — that is a liveness guard so the
 * session stays usable after external interference, not a selection feature.
 */
export interface BrowserController {
  /**
   * Open a fresh blank tab for a task run.
   *
   * @returns nothing; a new active tab whose URL is `about:blank` is ready
   *   for browser operations. Rejects if a task tab is already active.
   */
  newTab(options?: BrowserOperationOptions): Promise<void>;

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
  goto(url: string, options?: BrowserOperationOptions): Promise<void>;

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
   * Capture a page as PNG bytes.
   *
   * @param options - optional page selection, and viewport or full-page
   *   capture selection; an omitted `pageId` means the selected page
   * @returns the complete PNG file bytes without writing an artifact
   */
  screenshot(options?: BrowserScreenshotOptions): Promise<Uint8Array>;

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
   * HTTP(S) refs and URLs are opened in a temporary page so the acted-on page
   * remains unchanged; the main navigation response or resulting browser
   * download is captured exactly. Refs without an HTTP(S) href are clicked on
   * the target page and must trigger a browser download event.
   *
   * @param target - an inspected page ref or an absolute HTTP(S) URL, plus an
   *   optional `pageId`; omitted means the selected page
   * @returns exact bytes plus the final URL and available response metadata
   */
  download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult>;

  /**
   * Read a page's current URL.
   *
   * @param pageId - page to read; omitted means the selected page
   * @returns the absolute current URL, including the landed URL after a
   *   redirect. Throws when no task tab is active (pageId omitted) or the
   *   named page is unknown or closed.
   */
  currentUrl(pageId?: string): string;

  /**
   * Read a page's document title.
   *
   * @param pageId - page to read; omitted means the selected page
   * @returns the current document title. Rejects when no task tab is active
   *   (pageId omitted) or the named page is unknown or closed.
   */
  title(pageId?: string): Promise<string>;

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
   * Close the browser session and every page it owns.
   *
   * @returns nothing; all browser resources are released. Repeated calls are
   *   safe and no later browser operation may succeed.
   */
  /**
   * Evaluate a snippet in a page's top document (T6).
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
   * @param request - the page (via `pageId`, omitted meaning the selected
   *   page), the snippet, and its clamped deadline
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
   * Open a CDP command channel pinned to one exact tracked page.
   *
   * Unlike {@link prepareForBrowserScript}, this never hands a connection URL
   * to its caller. The controller resolves `pageId` once, creates one attached
   * CDP session for that page, reads the target id through that same session,
   * and retains it until the returned session is closed. A missing or stale
   * page rejects rather than falling back to another open tab.
   *
   * @param pageId - page to bind; omitted means the selected task page
   * @returns a target-pinned command session containing no transport details
   */
  openCommandSession(pageId?: string): Promise<BrowserCommandSession>;

  /**
   * Reconcile controller state after commands may have changed pages outside
   * the controller's ordinary action methods.
   *
   * This capability is provider-neutral and unconditional: both local Chrome
   * and a Browserbase-backed Playwright context can be rescanned without
   * exposing their connection details. It invalidates observations that may
   * have become stale, adopts newly visible pages, and fails loudly when the
   * underlying browser is no longer usable.
   */
  refreshAfterExternalCommands(): Promise<void>;

  /** Return every JavaScript dialog currently blocking an owned page. */
  listPendingDialogs(): readonly BrowserDialog[];

  /**
   * Recover page ownership for one durable run before opening its task tab.
   *
   * Implementations that host multiple clients in one persistent browser may
   * use `ownershipId` to find and close pages left by an earlier process for
   * this exact run. Unrelated pages must remain untouched. The same call also
   * arms durable ownership marking for pages the controller subsequently
   * creates or claims, including popups and pages that navigate cross-origin.
   *
   * OPTIONAL because a provider whose browser lifetime is already bounded by
   * the harness process has no stale attached-session pages to reclaim. When
   * present, the coordinator calls it with the stable run id after acquiring
   * the session and before `newTab()` or any navigation. Repeating the same id
   * is safe. A different id rejects until `closeTaskPages()` removes the exact
   * context init script and reaches a proven quiescent fixed point; failed
   * cleanup leaves the controller bound.
   */
  initializeRunPageOwnership?(
    ownershipId: string,
    options?: BrowserOperationOptions,
  ): Promise<void>;

  /** Atomically prepare a run-owned task page under cancellation. Unlike
   * composing the legacy methods at a caller, this boundary owns containment
   * of a late `newTab` or `goto` effect. V3 requires this capability whenever
   * it receives a browser controller. */
  prepareTaskPage?(request: BrowserTaskPagePreparation): Promise<void>;

  /**
   * Close every page created for the current task, including owned popups and
   * raw-CDP targets, while leaving pre-existing or concurrently user-created
   * pages alone. Every owned page is attempted even if an earlier close
   * fails; repeated calls are safe.
   */
  closeTaskPages(): Promise<void>;

  /**
   * Prepare this session to be driven by an external browser script: a
   * short-lived process that opens its OWN Playwright connection to the SAME
   * running Chrome over CDP, so it can act on one exact tab of this
   * controller's — the named page, or the selected page when `pageId` is
   * omitted — without this controller ever selecting that page itself.
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
   * @param pageId - page to hand to the script; omitted means the selected
   *   page
   * @returns the CDP endpoint and the resolved page's CDP target id
   * @throws Error when the resolved page does not exist (no task tab active,
   *   for an omitted `pageId`; an unknown or closed page, for a named one),
   *   or this controller has no CDP endpoint configured
   */
  prepareForBrowserScript?(pageId?: string): Promise<BrowserScriptSetup>;

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

  /**
   * Hand out a source of fresh, throwaway pages for rendering a document
   * output to PDF.
   *
   * OPTIONAL: a session that cannot make pages omits it, and a `pdf` document
   * output then fails with an explicit "this run cannot render PDFs" error
   * BEFORE anything is written — which is the point. The alternative failure,
   * publishing rendered text under a `.pdf` filename, produces a file the
   * verifier accepts and a human cannot open.
   *
   * The returned source must never hand back the worker's selected page.
   * Rendering into it would navigate the agent's own session away mid-run,
   * invalidating every ref and observation the model is holding, and the PDF
   * would inherit that page's cookies and network policy instead of the
   * renderer's isolated one. Returning a page FACTORY rather than a page is
   * what makes that guarantee structural: the renderer opens its own page,
   * disables its network, and closes it, so there is no shared page to leak.
   *
   * @returns something that can open a new page; a Playwright `Browser` or
   *   `BrowserContext` satisfies it structurally. Typed against Playwright
   *   because the renderer drives a real `Page` (routing, print media,
   *   `page.pdf`) — a hand-rolled structural stand-in would have to restate
   *   Playwright's own types and could drift from them silently.
   */
  pdfPageSource?(): Pick<Browser, 'newPage'>;

  /**
   * Give this controller the run's busy-resource registry, so its own
   * internal renderer-read timeouts (a controller-level concern below the
   * tool-level `ToolCtx.busyRegistry` gate) register their abandonments in
   * the SAME ledger a later tool call's gate checks against.
   *
   * OPTIONAL: a controller with no internal timeout of its own (a test
   * double, a future non-Playwright backend) omits it, and simply gets no
   * protection from abandoned-read races — exactly today's behavior.
   */
  setBusyRegistry?(registry: BusyResourceRegistry): void;

  /**
   * Provider-neutral, user-facing facts about where this session is hosted:
   * vendor session id, Live View URL, recording URL.
   *
   * OPTIONAL: a local Chrome session has nothing to say here and omits it.
   * Read by application runtimes (the TUI, the REPL) to show a human where
   * to watch or take over a remote session. Deliberately NOT a method and
   * deliberately carrying no connection URL — see
   * {@link BrowserSessionDiagnostics}.
   */
  readonly sessionDiagnostics?: BrowserSessionDiagnostics;

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
