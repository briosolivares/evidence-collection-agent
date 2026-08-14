/**
 * Receipted browser action sequences (T10).
 *
 * `browser_batch` executed a list of tool calls blindly: the model learned
 * only that "something failed", never which effects had already landed, and
 * a mid-batch navigation happily ran the remaining actions against whatever
 * document had replaced the one the refs came from. This module replaces
 * that with a sequence that reports exactly what it did:
 *
 * 1. **Revalidate immediately before acting.** Every element target is
 *    re-resolved against its own document right before its action (see
 *    {@link ActionCapableSession.resolveTarget}), so a reordered list or a
 *    replaced document produces a `stale` receipt instead of a wrong-target
 *    mutation.
 * 2. **One receipt per attempted action**, each carrying
 *    `effectsCommitted`. Unexecuted actions get no receipt; their first
 *    index is named once in {@link BrowserActionOutput.stoppedBeforeIndex}.
 * 3. **Stop at every boundary that invalidates the plan**: navigation,
 *    document replacement, a popup, a dialog, a stale target, or a failure.
 *    A *final* action that navigates is still `completed` — the plan
 *    finished; only remaining actions make it `partial`.
 * 4. **Never imply rollback.** A failed success check after committed side
 *    effects is `failed_check` with the receipts still saying committed.
 * 5. **Three separate waits** (success checks, DOM quiet window, settle
 *    budget) with finite defaults and finite caps. There is deliberately no
 *    global `networkidle` wait: on live applications it never arrives, and
 *    "the whole network is idle" was never the claim worth making.
 *
 * The engine seam ({@link ActionCapableSession}) keeps Playwright out of
 * this file so the sequencing, status, and classification rules stay
 * testable without a browser; `PlaywrightBrowserController` adapts itself
 * to the seam.
 */

import { resolveRunPath } from '../run/runDir.js';
import type {
  BrowserObservation,
  BrowserObserveRequest,
  BrowserPage,
  ElementRef,
  ObservationView,
  PageChanges,
} from './browserState.js';
import { BrowserRefNotFoundError } from './controller.js';

/** Direction a scroll action moves the page. */
export type ScrollDirection = 'up' | 'down';

/** How far a scroll action moves: exact pixels, or viewport multiples. */
export interface ScrollAmount {
  unit: 'pixels' | 'viewport';
  value: number;
}

/**
 * One action in a sequence. Element-addressed ops carry the full
 * {@link ElementRef} the model observed — the ref's own page/frame/document
 * identity is what makes revalidation precise, so it travels with the
 * action rather than being inferred from "whatever is selected".
 *
 * `drag` from the proposal is deliberately absent in this task: it needs a
 * two-target revalidation contract and a drag fixture that does not depend
 * on HTML5 drag emulation, and untested action code is worse than no
 * action code.
 */
export type BrowserAction =
  | { op: 'navigate'; url: string }
  | { op: 'click'; target: ElementRef }
  | { op: 'fill'; target: ElementRef; text: string }
  | { op: 'press'; target?: ElementRef; key: string }
  | { op: 'select'; target: ElementRef; values: readonly string[] }
  | { op: 'check'; target: ElementRef; checked: boolean }
  | { op: 'hover'; target: ElementRef }
  | { op: 'upload'; target: ElementRef; runPath: string }
  | { op: 'scroll'; direction: ScrollDirection; amount: ScrollAmount };

/** An explicit, observable definition of "the action worked". Checks are
 * the only thing the runtime waits *for*; everything else is a bounded
 * settle heuristic. */
export type SuccessCheck =
  | { type: 'url_matches'; pattern: string }
  | { type: 'element_exists'; role: string; name: string }
  | { type: 'text_present'; text: string }
  | { type: 'download_started' }
  | { type: 'popup_opened' };

/** One requested check and whether it was observed to pass. */
export interface SuccessCheckOutcome {
  check: SuccessCheck;
  passed: boolean;
}

/** Caller overrides for the three independent waits. Every field is
 * clamped by {@link resolveSettlePolicy}; a caller can shorten a wait
 * freely but can never extend it past the provider's finite cap. */
export interface SettlePolicy {
  /** How long to wait for the requested success checks to all pass. */
  successCheckTimeoutMs?: number;
  /** How long the DOM must stop mutating before the page counts as quiet. */
  quietWindowMs?: number;
  /** Total budget for reaching that quiet window. */
  settleTimeoutMs?: number;
}

/** A settle policy with every field resolved to a finite number. */
export type ResolvedSettlePolicy = Required<SettlePolicy>;

/** Defaults from the proposal: long enough for a real page transition,
 * short enough that a stuck page cannot eat a turn. */
export const DEFAULT_SETTLE_POLICY: ResolvedSettlePolicy = {
  successCheckTimeoutMs: 10_000,
  quietWindowMs: 250,
  settleTimeoutMs: 2_000,
};

/** Hard caps on caller overrides. A model that asks for a 10-minute wait
 * gets 30 seconds: these bounds exist so one tool call cannot stall a run. */
export const MAX_SETTLE_POLICY: ResolvedSettlePolicy = {
  successCheckTimeoutMs: 30_000,
  quietWindowMs: 1_000,
  settleTimeoutMs: 10_000,
};

/** Actions allowed in one sequence. Eight is enough for "fill a form and
 * submit it" and small enough that a stop mid-sequence leaves the model a
 * comprehensible amount of unexecuted work. */
export const MAX_ACTIONS_PER_SEQUENCE = 8;

/** Entries kept per {@link PageChanges} array in an action result. Tighter
 * than the observation cap: an action result also carries receipts, pages,
 * dialogs, and downloads, and must still fit a tool result comfortably. */
export const MAX_ACTION_CHANGE_ENTRIES = 40;

/** Characters kept per changed-text entry — a huge text node cannot
 * balloon a diff that exists to say *what* changed. */
export const MAX_CHANGE_TEXT_CHARS = 200;

/** Characters kept per returned view. Views are returned only when the
 * diff cannot carry the picture (an evicted or absent baseline), so this
 * is the floor of "actionable content", not a page dump. */
export const MAX_ACTION_VIEW_CHARS = 8_000;

/** Per-collection caps for the incidental things an action can produce. */
export const MAX_REPORTED_PAGES = 5;
export const MAX_REPORTED_DIALOGS = 5;
export const MAX_REPORTED_DOWNLOADS = 5;

/** Longest `Retry-After` a `blocked` result will echo. A server asking for
 * an hour is real information, but a bounded value is what a caller can
 * act on; anything larger is reported as an unbounded block instead. */
export const MAX_RETRY_AFTER_MS = 300_000;

/** How long to keep watching for a navigation/popup/dialog triggered by an
 * action that plausibly causes one. Resolves as soon as a signal arrives,
 * so the cost is paid only when nothing happened. */
export const NAVIGATION_DETECT_WINDOW_MS = 250;

/** Ops that plausibly commit a navigation, open a page, or raise a dialog,
 * and therefore earn the detect window above. `fill`/`hover`/`scroll` do
 * not: in the rare case one of them navigates, the *next* action's target
 * revalidation catches the replaced document and reports `stale` rather
 * than acting on the wrong document. */
const NAVIGATING_OPS: ReadonlySet<BrowserAction['op']> = new Set([
  'navigate',
  'click',
  'press',
  'select',
  'check',
  'upload',
]);

/** Upper bound on how long the sequencer keeps watching for a dialog while
 * one action is in flight. Must exceed any single action's own engine
 * timeout, so a dialog that appears late still frees the sequence instead
 * of blocking on an action the modal dialog will never let finish. */
const DIALOG_ESCAPE_WINDOW_MS = 20_000;

/** Slice of the dialog watch. Short deliberately: the watch is re-armed
 * each slice, so an action that finishes normally leaves behind at most one
 * short pending timer instead of a multi-second one. */
const DIALOG_ESCAPE_POLL_MS = 100;

/** One attempted action's outcome. `effectsCommitted` is the field that
 * matters: it is the difference between "re-run this" and "check the page
 * before re-running this". */
export interface BrowserActionReceipt {
  /** Index in the requested `actions` array. */
  index: number;
  op: BrowserAction['op'];
  /** `completed` — the action ran; `failed` — it could not run or errored;
   * `stale` — its target could not be revalidated in its own document. */
  status: 'completed' | 'failed' | 'stale';
  /** True iff this action's side effects landed in the page. Never
   * retracted later: nothing in this module rolls anything back. */
  effectsCommitted: boolean;
  /** Bounded failure message for a non-completed action. */
  error?: string;
}

/** A resource the browser started downloading during the sequence. Bytes
 * are deliberately not captured here; `download` remains the tool that
 * saves evidence. */
export interface DownloadInfo {
  pageId: string;
  sourceUrl: string;
  suggestedFilename?: string;
}

/** A JavaScript dialog waiting for an explicit decision. While one is
 * pending the page's renderer is blocked, which is why the sequence stops
 * and no observation is attempted. */
export interface BrowserDialog {
  dialogId: string;
  pageId: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
}

/** Why the page will not let the run proceed. Distinct from a failure:
 * the action mechanics worked, the *site* said no. */
export type BrowserBlockReason =
  | 'login'
  | 'captcha'
  | 'rate_limit'
  | 'bot_challenge'
  | 'permission';

/** Raw evidence a blocked classification is drawn from. Collected by the
 * engine, judged by {@link classifyBlockedState} — so the judging rules
 * are unit-testable without a browser. */
export interface BlockSignals {
  /** The page's current URL. */
  url: string;
  /** Bounded visible page text. */
  text: string;
  /** Whether the document exposes a password input. */
  hasPasswordField: boolean;
  /** URLs of the page's frames (CAPTCHA widgets live in iframes). */
  frameUrls: readonly string[];
  /** Status of the response that produced the current document, when known. */
  status?: number;
  /** That response's raw `Retry-After` header, when present. */
  retryAfterHeader?: string;
}

/** A recognized blocked state plus a bounded retry delay when the server
 * named one. */
export interface BrowserBlock {
  reason: BrowserBlockReason;
  retryAfterMs?: number;
}

/** One page's identity without touching the renderer — safe to read while
 * a modal dialog has the page blocked. */
export interface DocumentSnapshot {
  documentId: string;
  url: string;
}

/** Page-level things that happened since a {@link PageWatch} started. */
export interface PageActivity {
  /** Main-frame document replacements observed. */
  navigations: number;
  /** Stable ids of pages that appeared (popups, `target=_blank`). */
  openedPageIds: readonly string[];
  /** Dialogs raised on the watched page and still awaiting a decision. */
  dialogs: readonly BrowserDialog[];
  /** Downloads the watched page started. */
  downloads: readonly DownloadInfo[];
}

/** A sequence-scoped subscription to one page's activity. */
export interface PageWatch {
  /** Activity recorded so far. Cheap: no renderer round-trip. */
  activity(): PageActivity;
  /**
   * Wait until `predicate` holds for the current activity.
   *
   * @param predicate - tested on every recorded event and once up front
   * @param timeoutMs - finite budget; resolves on timeout as well, so the
   *   caller must re-test the predicate to learn which happened. A
   *   non-positive budget resolves after the initial test only.
   * @returns nothing; never rejects
   */
  waitUntil(
    predicate: (activity: PageActivity) => boolean,
    timeoutMs: number,
  ): Promise<void>;
  /** Release listeners. Idempotent. */
  stop(): void;
}

/** The revalidated, actionable form of one element target. Obtained
 * immediately before its action and never reused for a later one. */
export interface ActionTargetHandle {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  press(key: string): Promise<void>;
  selectOptions(values: readonly string[]): Promise<void>;
  setChecked(checked: boolean): Promise<void>;
  hover(): Promise<void>;
  /** Attach already-confined absolute paths to a file input. */
  setFiles(absolutePaths: readonly string[]): Promise<void>;
}

/**
 * The engine capability {@link performBrowserActions} needs. Every method
 * is a real browser capability, and none of them exposes page *selection*:
 * a sequence acts on the page it was given, so switching pages stays a
 * separate, deliberate tool call.
 */
export interface ActionCapableSession {
  /**
   * Resolve the page a request targets.
   *
   * @param pageId - explicit page, or undefined for the selected page
   * @returns the resolved stable page id
   * @throws Error when the id names no live tracked page (or none is
   *   selected)
   */
  resolvePageId(pageId?: string): string;
  /** Identity of the page's current main document, without renderer reads. */
  documentSnapshot(pageId: string): DocumentSnapshot;
  /** Full page description, including a renderer-read title. Never call
   * this while a dialog is pending — the renderer is blocked. */
  describePage(pageId: string): Promise<BrowserPage>;
  /** Page description with no renderer reads; `title` is ''. */
  describePageIdentity(pageId: string): BrowserPage;
  /** The page's latest observation number (0 before any observation). */
  latestObservationId(pageId: string): number;
  /** Start recording page activity for one sequence. */
  watchPage(pageId: string): PageWatch;
  /**
   * Revalidate an element ref and return an actionable handle.
   *
   * @param target - the ref as observed
   * @returns a handle bound to exactly one element
   * @throws BrowserRefNotFoundError when the ref's document was replaced or
   *   the element can no longer be resolved uniquely
   */
  resolveTarget(target: ElementRef): Promise<ActionTargetHandle>;
  navigate(pageId: string, url: string): Promise<void>;
  /** Press a key with no element target (page-level keyboard). */
  pressKey(pageId: string, key: string): Promise<void>;
  scrollPage(
    pageId: string,
    direction: ScrollDirection,
    amount: ScrollAmount,
  ): Promise<void>;
  observe(request: BrowserObserveRequest): Promise<BrowserObservation>;
  /**
   * Poll the requested checks until all pass or the budget runs out.
   *
   * @param activity - live view of sequence activity, for the
   *   `download_started` / `popup_opened` checks
   * @returns one outcome per check, in request order
   */
  waitForSuccessChecks(
    pageId: string,
    checks: readonly SuccessCheck[],
    timeoutMs: number,
    activity: () => PageActivity,
  ): Promise<SuccessCheckOutcome[]>;
  /**
   * Wait for the DOM to stop mutating.
   *
   * @returns true when a full quiet window elapsed inside the settle
   *   budget; false when the budget ran out or quiescence could not be
   *   observed at all. Never rejects — an unsettled page is a reported
   *   fact, not an error.
   */
  waitForDomQuiescence(
    pageId: string,
    quietWindowMs: number,
    settleTimeoutMs: number,
  ): Promise<boolean>;
  /** Collect the evidence a blocked classification is drawn from. */
  blockSignals(pageId: string): Promise<BlockSignals>;
}

/** One requested action sequence, all against one page and document. */
export interface BrowserActionRequest {
  /** Page to act on; omitted means the selected page. */
  pageId?: string;
  /** The document the caller believes it is acting in. An optimistic
   * precondition: a mismatch fails the whole sequence before any side
   * effect. Element refs carry their own document identity regardless, so
   * omitting this weakens the precondition but never the per-target
   * revalidation. */
  documentId?: string;
  /** Observation to diff the resulting page against. Not a lock: an
   * evicted baseline degrades to a bounded full snapshot. */
  basedOnObservationId?: number;
  /** 1..{@link MAX_ACTIONS_PER_SEQUENCE} actions, executed in order. */
  actions: readonly BrowserAction[];
  /** Explicit definitions of success, waited for after the last committed
   * action. */
  successChecks?: readonly SuccessCheck[];
  settle?: SettlePolicy;
  /** Absolute run directory. Required only when the sequence uploads: it
   * is the confinement root every upload path is resolved through. */
  runDir?: string;
}

/**
 * The result of one sequence. Statuses, in the order they are decided:
 *
 * - `stale` — a target could not be revalidated (or the requested document
 *   was already replaced). Earlier receipts still say what committed.
 * - `failed` — an action errored, or the request could not be executed at
 *   all (e.g. an upload path outside the run directory: nothing ran).
 * - `partial` — actions remain unexecuted; `stoppedBeforeIndex` names the
 *   first of them and `stopReason` says why.
 * - `failed_check` — everything ran, a success check did not pass. Side
 *   effects stay committed.
 * - `completed` — everything ran and every requested check passed.
 * - `blocked` — overrides the above (except a fully passing check set)
 *   when the page shows a recognizable login/CAPTCHA/rate-limit/bot/
 *   permission wall: that is more actionable than "click failed".
 */
export interface BrowserActionOutput {
  status: 'completed' | 'partial' | 'stale' | 'blocked' | 'failed_check' | 'failed';
  /** The observation number the caller's plan was based on. */
  previousObservationId: number;
  /** One receipt per *attempted* action, in execution order. */
  actionReceipts: BrowserActionReceipt[];
  /** First index that did not run, when the sequence stopped early. */
  stoppedBeforeIndex?: number;
  stopReason?: 'navigation' | 'document_replaced' | 'popup' | 'dialog' | 'failure';
  /** True iff a full DOM quiet window was observed within the settle
   * budget. False is a fact about the page, never a failure. */
  settled: boolean;
  checks: SuccessCheckOutcome[];
  currentPage: BrowserPage;
  changes: PageChanges;
  /** True when a change array or changed-text entry was cut by a cap. */
  changesTruncated: boolean;
  /** Bounded views, present only when `changes.basis` is `full_snapshot`
   * and the diff therefore carries nothing actionable. */
  views?: ObservationView[];
  openedPages: BrowserPage[];
  dialogs: BrowserDialog[];
  downloads: DownloadInfo[];
  blockedReason?: BrowserBlockReason;
  retryAfterMs?: number;
  /** Bounded message for the terminal problem, when there was one. */
  error?: string;
  /** Operational guidance that is not a failure (e.g. a pending dialog
   * blocked observation). */
  note?: string;
}

/**
 * Clamp a caller's settle policy into the provider's finite bounds.
 *
 * @param policy - caller overrides; omitted fields take the default
 * @returns every wait resolved to a finite number: defaults from
 *   {@link DEFAULT_SETTLE_POLICY}, overrides clamped to
 *   {@link MAX_SETTLE_POLICY} and to at least 1ms. Non-finite and
 *   non-positive overrides fall back to the default rather than throwing —
 *   a bad wait hint must not fail a sequence that would otherwise work
 */
export function resolveSettlePolicy(policy: SettlePolicy = {}): ResolvedSettlePolicy {
  return {
    successCheckTimeoutMs: clampWait(
      policy.successCheckTimeoutMs,
      DEFAULT_SETTLE_POLICY.successCheckTimeoutMs,
      MAX_SETTLE_POLICY.successCheckTimeoutMs,
    ),
    quietWindowMs: clampWait(
      policy.quietWindowMs,
      DEFAULT_SETTLE_POLICY.quietWindowMs,
      MAX_SETTLE_POLICY.quietWindowMs,
    ),
    settleTimeoutMs: clampWait(
      policy.settleTimeoutMs,
      DEFAULT_SETTLE_POLICY.settleTimeoutMs,
      MAX_SETTLE_POLICY.settleTimeoutMs,
    ),
  };
}

function clampWait(
  requested: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return fallback;
  }
  return Math.min(Math.floor(requested), maximum);
}

/**
 * Recognize a blocked page from its observable signals.
 *
 * Precedence is deliberate, most-specific first: a server-declared rate
 * limit beats page text; a CAPTCHA or bot interstitial beats the login
 * form it is usually wrapped around (solving the challenge is the next
 * step, signing in is not); an explicit login form beats a generic
 * permission denial. Every pattern needs a distinctive phrase, because a
 * false `blocked` would tell a run to stop when the page was fine.
 *
 * @param signals - page text/URL/frames plus response status and header
 * @returns the recognized block with a bounded `retryAfterMs` when the
 *   server named a usable delay, or undefined when nothing recognizable is
 *   present
 */
export function classifyBlockedState(signals: BlockSignals): BrowserBlock | undefined {
  const haystack = [
    signals.url,
    signals.text,
    ...signals.frameUrls,
  ]
    .join('\n')
    .toLowerCase();
  const retryAfterMs = parseRetryAfterMs(signals.retryAfterHeader);
  const withRetry = (reason: BrowserBlockReason): BrowserBlock =>
    retryAfterMs === undefined ? { reason } : { reason, retryAfterMs };

  if (
    signals.status === 429 ||
    /too many requests|rate limit(ed)?|slow down and try again|request throttled/.test(
      haystack,
    )
  ) {
    return withRetry('rate_limit');
  }
  if (/captcha|i'?m not a robot|are you a robot|hcaptcha|turnstile/.test(haystack)) {
    return withRetry('captcha');
  }
  if (
    /verify(ing)? (that )?you (are|'re) (a )?human|checking your browser|unusual traffic|automated queries|enable javascript and cookies to continue|additional verification required/.test(
      haystack,
    )
  ) {
    return withRetry('bot_challenge');
  }
  if (
    (signals.hasPasswordField && /sign in|signin|log in|login|password/.test(haystack)) ||
    (/\/(login|log-in|signin|sign-in|sso|oauth|authorize)(\/|\?|$)/.test(
      signals.url.toLowerCase(),
    ) &&
      /sign in|log in|continue with|password/.test(haystack))
  ) {
    return withRetry('login');
  }
  if (
    /403 forbidden|access denied|you (do not|don'?t) have permission|not authori[sz]ed|permission denied|insufficient permissions/.test(
      haystack,
    )
  ) {
    return withRetry('permission');
  }
  // Status-only fallbacks: a bare 401/403 body says nothing quotable, but
  // the status itself is unambiguous about which wall was hit.
  if (signals.status === 401) return withRetry('login');
  if (signals.status === 403) return withRetry('permission');
  return undefined;
}

/**
 * Parse a `Retry-After` header into a bounded delay.
 *
 * @param header - raw header value: delay-seconds or an HTTP date
 * @returns milliseconds in [0, {@link MAX_RETRY_AFTER_MS}], or undefined
 *   when absent, unparseable, already elapsed, or longer than the bound —
 *   "unknown" is more honest than a number a caller cannot act on
 */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  const seconds = Number(trimmed);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(trimmed) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds > MAX_RETRY_AFTER_MS) return undefined;
  return Math.round(milliseconds);
}

/**
 * Bound the page diff an action result carries.
 *
 * @param changes - the observation's diff
 * @returns the diff with every array cut to
 *   {@link MAX_ACTION_CHANGE_ENTRIES} and every changed text cut to
 *   {@link MAX_CHANGE_TEXT_CHARS}, plus whether anything was cut. The
 *   caller reports that flag: a silently shortened diff would read as "the
 *   page changed only this much"
 */
export function capPageChanges(changes: PageChanges): {
  changes: PageChanges;
  truncated: boolean;
} {
  const newlyVisible = changes.newlyVisible.slice(0, MAX_ACTION_CHANGE_ENTRIES);
  const noLongerVisibleElementIds = changes.noLongerVisibleElementIds.slice(
    0,
    MAX_ACTION_CHANGE_ENTRIES,
  );
  const updatedTextSource = changes.updatedText.slice(0, MAX_ACTION_CHANGE_ENTRIES);
  let textCut = false;
  const updatedText = updatedTextSource.map((entry) => {
    if (entry.text.length <= MAX_CHANGE_TEXT_CHARS) return entry;
    textCut = true;
    return { ...entry, text: entry.text.slice(0, MAX_CHANGE_TEXT_CHARS) };
  });

  const truncated =
    textCut ||
    newlyVisible.length < changes.newlyVisible.length ||
    noLongerVisibleElementIds.length < changes.noLongerVisibleElementIds.length ||
    updatedText.length < changes.updatedText.length;

  return {
    changes: { ...changes, newlyVisible, noLongerVisibleElementIds, updatedText },
    truncated,
  };
}

/**
 * Execute one action sequence against one page and document, reporting
 * exactly what committed.
 *
 * @param session - the engine seam (a browser controller adapts to it)
 * @param request - the page/document preconditions, 1..8 actions, optional
 *   success checks, settle overrides, and the run directory uploads are
 *   confined to
 * @returns a {@link BrowserActionOutput} whose receipts, `stoppedBeforeIndex`,
 *   `changes`, and `status` together describe every committed effect. Never
 *   rolls anything back, and never reports a stopped sequence as if the
 *   page were untouched
 * @throws RangeError when the action count is outside 1..8 (the tool schema
 *   normally rejects this first), and whatever the engine throws when the
 *   named page does not exist — a request that cannot even be aimed at a
 *   page has no receipts to report
 */
export async function performBrowserActions(
  session: ActionCapableSession,
  request: BrowserActionRequest,
): Promise<BrowserActionOutput> {
  const actions = request.actions;
  if (actions.length < 1 || actions.length > MAX_ACTIONS_PER_SEQUENCE) {
    throw new RangeError(
      `A browser action sequence must contain 1 to ${MAX_ACTIONS_PER_SEQUENCE} actions, got ${actions.length}.`,
    );
  }

  const settle = resolveSettlePolicy(request.settle);
  const pageId = session.resolvePageId(request.pageId);
  const startDocument = session.documentSnapshot(pageId);
  const previousObservationId =
    request.basedOnObservationId ?? session.latestObservationId(pageId);

  // --- Pre-flight. Everything here must fail with ZERO side effects, so a
  // rejected request leaves the page exactly as the caller found it. ---
  const preflight = preflightSequence(request, pageId, startDocument);
  if (preflight.kind === 'rejected') {
    return finishSequence(session, {
      pageId,
      previousObservationId,
      basedOnObservationId: request.basedOnObservationId,
      receipts: [],
      stoppedBeforeIndex: 0,
      stopReason: preflight.stopReason,
      status: preflight.status,
      error: preflight.error,
      checks: [],
      settled: false,
      committedAny: false,
      watch: undefined,
      settlePolicy: settle,
      successChecks: request.successChecks ?? [],
    });
  }

  const watch = session.watchPage(pageId);
  const receipts: BrowserActionReceipt[] = [];
  let stoppedBeforeIndex: number | undefined;
  let stopReason: BrowserActionOutput['stopReason'];
  let terminalError: string | undefined;
  let committedAny = false;
  let knownDocument = startDocument;

  try {
    for (const [index, action] of actions.entries()) {
      const isLast = index === actions.length - 1;
      const attempt = await attemptAction(
        session,
        watch,
        pageId,
        index,
        action,
        preflight.uploadPaths.get(index),
      );
      receipts.push(attempt.receipt);
      if (attempt.receipt.effectsCommitted) committedAny = true;

      if (attempt.receipt.status !== 'completed') {
        terminalError = attempt.receipt.error;
        if (!isLast) {
          stoppedBeforeIndex = index + 1;
          stopReason = 'failure';
        }
        break;
      }

      const interruption = await detectInterruption(
        session,
        watch,
        pageId,
        knownDocument,
        NAVIGATING_OPS.has(action.op) ? NAVIGATION_DETECT_WINDOW_MS : 0,
        attempt.sawDialog,
      );
      knownDocument = session.documentSnapshot(pageId);
      if (interruption !== undefined && !isLast) {
        // The boundary the old batch tool ignored: whatever comes next was
        // planned against a document that no longer exists.
        stoppedBeforeIndex = index + 1;
        stopReason = interruption;
        break;
      }
    }

    const failing = receipts.find((receipt) => receipt.status !== 'completed');
    const status: BrowserActionOutput['status'] =
      failing?.status === 'stale'
        ? 'stale'
        : failing !== undefined
          ? 'failed'
          : stoppedBeforeIndex !== undefined
            ? 'partial'
            : 'completed';

    return await finishSequence(session, {
      pageId,
      previousObservationId,
      basedOnObservationId: request.basedOnObservationId,
      receipts,
      ...(stoppedBeforeIndex !== undefined ? { stoppedBeforeIndex } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      status,
      ...(terminalError !== undefined ? { error: terminalError } : {}),
      checks: [],
      settled: false,
      committedAny,
      watch,
      settlePolicy: settle,
      successChecks: request.successChecks ?? [],
    });
  } finally {
    watch.stop();
  }
}

/** A pre-flight verdict: either the resolved upload paths, or a rejection
 * that has touched nothing. */
type PreflightResult =
  | { kind: 'accepted'; uploadPaths: Map<number, string> }
  | {
      kind: 'rejected';
      status: 'stale' | 'failed';
      stopReason: BrowserActionOutput['stopReason'];
      error: string;
    };

/**
 * Check every precondition that can be checked without touching the page:
 * the requested document still exists, every target belongs to this page
 * and document, and every upload path resolves inside the run directory.
 */
function preflightSequence(
  request: BrowserActionRequest,
  pageId: string,
  document: DocumentSnapshot,
): PreflightResult {
  if (request.documentId !== undefined && request.documentId !== document.documentId) {
    return {
      kind: 'rejected',
      status: 'stale',
      stopReason: 'document_replaced',
      error:
        `Page ${pageId} is now in document ${document.documentId} (${document.url}), ` +
        `not the requested ${request.documentId}. Nothing was executed; observe the ` +
        `page again and retarget.`,
    };
  }

  const uploadPaths = new Map<number, string>();
  for (const [index, action] of request.actions.entries()) {
    const target = actionTarget(action);
    if (target !== undefined) {
      if (target.pageId !== pageId) {
        return {
          kind: 'rejected',
          status: 'failed',
          stopReason: 'failure',
          error:
            `Action ${index} targets an element observed on page ${target.pageId}, but the ` +
            `sequence runs on page ${pageId}. One sequence acts on one page; use switch_page ` +
            `or send a separate call. Nothing was executed.`,
        };
      }
      if (target.documentId !== document.documentId) {
        return {
          kind: 'rejected',
          status: 'stale',
          stopReason: 'document_replaced',
          error:
            `Action ${index} targets an element from document ${target.documentId}, but page ` +
            `${pageId} is now in document ${document.documentId} (${document.url}). Nothing was ` +
            `executed; observe the page again and retarget.`,
        };
      }
    }

    if (action.op === 'upload') {
      if (request.runDir === undefined) {
        return {
          kind: 'rejected',
          status: 'failed',
          stopReason: 'failure',
          error:
            `Action ${index} uploads a file, but this session has no run directory to resolve ` +
            `it against. Nothing was executed.`,
        };
      }
      try {
        // The single confinement chokepoint: an absolute path or any
        // traversal out of the run directory is rejected here, before the
        // page has been touched at all.
        uploadPaths.set(index, resolveRunPath(request.runDir, action.runPath));
      } catch (thrown) {
        return {
          kind: 'rejected',
          status: 'failed',
          stopReason: 'failure',
          error:
            `Action ${index} cannot upload ${JSON.stringify(action.runPath)}: ` +
            `${messageOf(thrown)} Upload only files inside the run directory. Nothing was executed.`,
        };
      }
    }
  }

  return { kind: 'accepted', uploadPaths };
}

/** The element ref an action mutates, or undefined for page-level ops. */
function actionTarget(action: BrowserAction): ElementRef | undefined {
  return 'target' in action ? action.target : undefined;
}

/** One attempted action: its receipt, plus whether a dialog cut the action
 * short (the page's renderer is then blocked). */
interface ActionAttempt {
  receipt: BrowserActionReceipt;
  sawDialog: boolean;
}

/**
 * Revalidate this action's target, then perform it.
 *
 * Revalidation happens here — immediately before the action — rather than
 * once for the whole sequence: an earlier action in the same sequence can
 * reorder, replace, or remove a later action's target, and a sequence-wide
 * pre-resolve would happily mutate the wrong element.
 */
async function attemptAction(
  session: ActionCapableSession,
  watch: PageWatch,
  pageId: string,
  index: number,
  action: BrowserAction,
  uploadPath: string | undefined,
): Promise<ActionAttempt> {
  let started: StartedAction;
  try {
    started = await startAction(session, pageId, action, uploadPath);
  } catch (thrown) {
    const stale = thrown instanceof BrowserRefNotFoundError;
    return {
      receipt: {
        index,
        op: action.op,
        status: stale ? 'stale' : 'failed',
        // Nothing was performed: revalidation (or op setup) failed first.
        effectsCommitted: false,
        error: stale
          ? `Target ${describeTarget(action)} could not be revalidated in the current document; ` +
            `observe the page again and retarget. No effects from this action.`
          : messageOf(thrown),
      },
      sawDialog: false,
    };
  }

  const dialogsBefore = watch.activity().dialogs.length;
  const outcome = await raceDialogEscape(started.work, watch, dialogsBefore);
  if (outcome.kind === 'dialog') {
    // A dialog proves the action's handler ran, and the modal will not let
    // the driver's promise resolve until it is answered. Report committed
    // effects and stop; handle_dialog is the next move.
    return {
      receipt: { index, op: action.op, status: 'completed', effectsCommitted: true },
      sawDialog: true,
    };
  }
  if (outcome.kind === 'failed') {
    const stale = outcome.error instanceof BrowserRefNotFoundError;
    return {
      receipt: {
        index,
        op: action.op,
        status: stale ? 'stale' : 'failed',
        // The action was attempted against a resolved target. Playwright
        // fails before dispatching input for every case we can distinguish,
        // so "not committed" is the honest default; a caller must still
        // check the page, which is what the returned changes are for.
        effectsCommitted: false,
        error: stale
          ? `Target ${describeTarget(action)} went stale while acting; observe the page again.`
          : messageOf(outcome.error),
      },
      sawDialog: false,
    };
  }

  return {
    receipt: { index, op: action.op, status: 'completed', effectsCommitted: true },
    sawDialog: false,
  };
}

/** An action that is now in flight. The promise is wrapped in an object on
 * purpose: an `async` function that *returned* it would adopt it and only
 * resolve once the action finished, which is exactly the waiting the dialog
 * escape below exists to avoid. */
interface StartedAction {
  work: Promise<void>;
}

/** Resolve the target (when the op has one) and start the engine call.
 * Returns the in-flight promise so the caller can race it against a
 * dialog; a resolution failure throws before anything is performed. */
async function startAction(
  session: ActionCapableSession,
  pageId: string,
  action: BrowserAction,
  uploadPath: string | undefined,
): Promise<StartedAction> {
  switch (action.op) {
    case 'navigate':
      return { work: session.navigate(pageId, action.url) };
    case 'scroll':
      return { work: session.scrollPage(pageId, action.direction, action.amount) };
    case 'press': {
      if (action.target === undefined) {
        return { work: session.pressKey(pageId, action.key) };
      }
      const handle = await session.resolveTarget(action.target);
      return { work: handle.press(action.key) };
    }
    case 'click':
      return { work: (await session.resolveTarget(action.target)).click() };
    case 'fill':
      return { work: (await session.resolveTarget(action.target)).fill(action.text) };
    case 'select':
      return {
        work: (await session.resolveTarget(action.target)).selectOptions(action.values),
      };
    case 'check':
      return {
        work: (await session.resolveTarget(action.target)).setChecked(action.checked),
      };
    case 'hover':
      return { work: (await session.resolveTarget(action.target)).hover() };
    case 'upload': {
      if (uploadPath === undefined) {
        // Unreachable through performBrowserActions (pre-flight resolves
        // every upload path first); stated explicitly so a future caller
        // cannot bypass the confinement chokepoint by accident.
        throw new Error(
          'Upload action reached the engine without a run-confined path; resolve it through resolveRunPath first.',
        );
      }
      const handle = await session.resolveTarget(action.target);
      return { work: handle.setFiles([uploadPath]) };
    }
  }
}

/** The outcome of racing an in-flight action against a new dialog. */
type ActionRace =
  | { kind: 'done' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'dialog' };

/**
 * Await an action, escaping early if it raised a modal dialog.
 *
 * A page with an unanswered dialog will not run script or resolve the
 * driver's action promise, so waiting for the action alone would burn its
 * whole timeout on a page that is merely asking a question.
 */
async function raceDialogEscape(
  work: Promise<void>,
  watch: PageWatch,
  dialogsBefore: number,
): Promise<ActionRace> {
  const dialogAppeared = (activity: PageActivity): boolean =>
    activity.dialogs.length > dialogsBefore;
  let outcome: ActionRace | undefined;
  // Mapped to a value, never a rejection: after a dialog escape this
  // promise is abandoned, and an abandoned rejecting promise would surface
  // as an unhandled rejection much later, in an unrelated test or turn.
  const settled: Promise<ActionRace> = work
    .then(
      () => ({ kind: 'done' }) as ActionRace,
      (error: unknown) => ({ kind: 'failed', error }) as ActionRace,
    )
    .then((result) => {
      outcome = result;
      return result;
    });

  const deadline = Date.now() + DIALOG_ESCAPE_WINDOW_MS;
  while (outcome === undefined && Date.now() < deadline) {
    // Re-armed in short slices rather than waited for once: a normally
    // finishing action then leaves at most one brief pending timer behind.
    await Promise.race([settled, watch.waitUntil(dialogAppeared, DIALOG_ESCAPE_POLL_MS)]);
    if (outcome !== undefined) break;
    if (dialogAppeared(watch.activity())) return { kind: 'dialog' };
  }
  return outcome ?? (await settled);
}

/**
 * Decide whether something happened after an action that invalidates the
 * rest of the plan.
 *
 * @param window - how long to keep waiting for a signal; resolves as soon
 *   as one arrives
 * @returns the stop reason, or undefined when the page is still the same
 *   document with no popup or dialog. Priority is dialog → popup →
 *   navigation: a dialog blocks the renderer outright, a popup moves the
 *   user's attention, and only then does the document transition matter
 */
async function detectInterruption(
  session: ActionCapableSession,
  watch: PageWatch,
  pageId: string,
  knownDocument: DocumentSnapshot,
  window: number,
  sawDialog: boolean,
): Promise<BrowserActionOutput['stopReason'] | undefined> {
  if (sawDialog) return 'dialog';

  // ANY dialog or opened page recorded by the (sequence-scoped) watch counts,
  // rather than a delta measured after the action: the popup event routinely
  // arrives while the click's own promise is still resolving, so a baseline
  // taken here would already contain it and the delta would be zero. The
  // sequence breaks at the first interruption, so nothing recorded can
  // predate the action being judged. Navigation stays a per-action document
  // comparison, because an earlier `navigate` in the same sequence
  // legitimately leaves a navigation on the record.
  const interrupted = (activity: PageActivity): boolean => {
    if (activity.dialogs.length > 0 || activity.openedPageIds.length > 0) return true;
    try {
      return session.documentSnapshot(pageId).documentId !== knownDocument.documentId;
    } catch {
      // The page itself closed. This predicate can run SYNCHRONOUSLY inside
      // the controller's own 'close' event handling (via
      // watch.waitUntil -> signalActivity, fired the moment the page's
      // tracking record is torn down) — documentSnapshot throwing there is
      // not a distinct failure to propagate, it IS the page-closed signal,
      // unmistakably an interruption. Letting it escape instead would throw
      // synchronously from inside Playwright's own event dispatch.
      return true;
    }
  };
  if (window > 0 && !interrupted(watch.activity())) {
    await watch.waitUntil(interrupted, window);
  }

  const activity = watch.activity();
  if (activity.dialogs.length > 0) return 'dialog';
  if (activity.openedPageIds.length > 0) return 'popup';

  const now = session.documentSnapshot(pageId);
  if (now.documentId !== knownDocument.documentId) {
    return now.url === knownDocument.url ? 'document_replaced' : 'navigation';
  }
  return undefined;
}

/** Everything the settle-and-report phase needs from the execution phase. */
interface SequenceState {
  pageId: string;
  previousObservationId: number;
  basedOnObservationId: number | undefined;
  receipts: BrowserActionReceipt[];
  stoppedBeforeIndex?: number;
  stopReason?: BrowserActionOutput['stopReason'];
  status: BrowserActionOutput['status'];
  error?: string;
  checks: SuccessCheckOutcome[];
  settled: boolean;
  committedAny: boolean;
  /** Absent for a pre-flight rejection: nothing was watched because
   * nothing ran. */
  watch: PageWatch | undefined;
  settlePolicy: ResolvedSettlePolicy;
  successChecks: readonly SuccessCheck[];
}

/**
 * Settle, observe, classify, and assemble the output.
 *
 * The order matters: waits happen before the snapshot (a snapshot taken
 * mid-reaction would report a half-observed page as the result), and
 * blocked classification happens after the snapshot (the wall is whatever
 * the page finally shows).
 */
async function finishSequence(
  session: ActionCapableSession,
  state: SequenceState,
): Promise<BrowserActionOutput> {
  const { pageId, watch } = state;
  const activity = watch?.activity() ?? {
    navigations: 0,
    openedPageIds: [],
    dialogs: [],
    downloads: [],
  };
  const dialogPending = activity.dialogs.length > 0;

  let checks = state.checks;
  let settled = state.settled;
  if (state.committedAny && !dialogPending && watch !== undefined) {
    checks =
      state.successChecks.length > 0
        ? await session.waitForSuccessChecks(
            pageId,
            state.successChecks,
            state.settlePolicy.successCheckTimeoutMs,
            () => watch.activity(),
          )
        : [];
    settled = await session.waitForDomQuiescence(
      pageId,
      state.settlePolicy.quietWindowMs,
      state.settlePolicy.settleTimeoutMs,
    );
  }

  // A pending dialog blocks the renderer: an observation (or even a title
  // read) would hang until someone answers it. Report identity only.
  let currentPage: BrowserPage;
  let changes: PageChanges;
  let views: ObservationView[] | undefined;
  if (dialogPending) {
    currentPage = session.describePageIdentity(pageId);
    changes = emptyChanges();
  } else {
    const observation = await session.observe({
      pageId,
      need: ['interactive'],
      ...(state.basedOnObservationId !== undefined
        ? { basedOnObservationId: state.basedOnObservationId }
        : {}),
    });
    currentPage = observation.page;
    changes = observation.changes;
    if (changes.basis === 'full_snapshot') {
      // No usable baseline, so the diff carries nothing: hand back bounded
      // views instead of an empty-looking "nothing changed".
      views = observation.views.map(boundView);
    }
  }

  const capped = capPageChanges(changes);
  const block = dialogPending
    ? undefined
    : classifyBlockedState(await session.blockSignals(pageId));
  const allChecksPassed =
    checks.length > 0 && checks.every((outcome) => outcome.passed);
  // A recognized wall is more actionable than the mechanical status —
  // unless the caller's own success criteria all passed, in which case the
  // model already knows the step worked and `blocked` would be a lie.
  const status: BrowserActionOutput['status'] =
    block !== undefined && !allChecksPassed
      ? 'blocked'
      : checks.some((outcome) => !outcome.passed) && state.status === 'completed'
        ? 'failed_check'
        : state.status;

  const openedPages = await describeOpenedPages(session, activity.openedPageIds);

  return {
    status,
    previousObservationId: state.previousObservationId,
    actionReceipts: state.receipts,
    ...(state.stoppedBeforeIndex !== undefined
      ? { stoppedBeforeIndex: state.stoppedBeforeIndex }
      : {}),
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    settled,
    checks,
    currentPage,
    changes: capped.changes,
    changesTruncated: capped.truncated,
    ...(views !== undefined ? { views } : {}),
    openedPages,
    dialogs: activity.dialogs.slice(0, MAX_REPORTED_DIALOGS).map((dialog) => ({
      ...dialog,
    })),
    downloads: activity.downloads.slice(0, MAX_REPORTED_DOWNLOADS).map((download) => ({
      ...download,
    })),
    ...(block !== undefined ? { blockedReason: block.reason } : {}),
    ...(block?.retryAfterMs !== undefined ? { retryAfterMs: block.retryAfterMs } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(dialogPending
      ? {
          note:
            'A dialog is waiting for a decision, so the page renderer is blocked and no ' +
            'observation was taken. Call handle_dialog, then observe.',
        }
      : {}),
  };
}

/** Describe the pages that appeared, skipping any that closed again — a
 * transient popup must not fail the whole result. */
async function describeOpenedPages(
  session: ActionCapableSession,
  pageIds: readonly string[],
): Promise<BrowserPage[]> {
  const pages: BrowserPage[] = [];
  for (const pageId of pageIds.slice(0, MAX_REPORTED_PAGES)) {
    try {
      pages.push(await session.describePage(pageId));
    } catch {
      continue;
    }
  }
  return pages;
}

/** The "nothing observed" diff: a full-snapshot basis with empty arrays,
 * matching how T9 reports an absent baseline. */
function emptyChanges(): PageChanges {
  return {
    basis: 'full_snapshot',
    navigated: false,
    newlyVisible: [],
    noLongerVisibleElementIds: [],
    updatedText: [],
  };
}

/** Cut a view to the action-result bound, preserving the truncation flag. */
function boundView(view: ObservationView): ObservationView {
  if (view.content.length <= MAX_ACTION_VIEW_CHARS) return view;
  return {
    ...view,
    content: view.content.slice(0, MAX_ACTION_VIEW_CHARS),
    truncated: true,
  };
}

/** Name an action's target for an error message: role/name reads like the
 * page, the element id ties it back to the observation. */
function describeTarget(action: BrowserAction): string {
  const target = actionTarget(action);
  if (target === undefined) return `for ${action.op}`;
  return `${target.role} "${target.name}" (${target.id})`;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
