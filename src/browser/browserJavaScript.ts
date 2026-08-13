/**
 * Page-scoped JavaScript: the engine-neutral contract (T6).
 *
 * This module holds the *types and pure rules* for running model-authored
 * code inside a browser document, deliberately separate from
 * `controller.ts`: the tool depends on the narrow
 * {@link JavaScriptCapablePage} seam below, so page JavaScript can be
 * developed and tested without a Chrome instance and without waiting on the
 * full page/frame identity model (T9/T10). The engine implementation
 * (`PlaywrightBrowserController.executeJavaScript` +
 * `replaceUnresponsivePage`) adapts itself to this seam; nothing here
 * imports Playwright.
 *
 * Three honesty rules the rest of T6 rests on:
 *
 * 1. Page JavaScript is a **page write**, never a read. One snippet can
 *    mutate the DOM, submit a form, or navigate; nothing about "I only
 *    queried the document" is enforceable, so no caller may schedule it as
 *    read-only.
 * 2. Page JavaScript is **not a sandbox**. Code runs with the page's full
 *    authority — its cookies, its session, its same-origin reach. Allowing
 *    it on an authenticated profile is accepted capability exposure, which
 *    is why {@link assertJavaScriptPolicy} makes an authenticated lane say
 *    so explicitly instead of inheriting a default.
 * 3. Only **JSON-compatible values** cross the boundary. A DOM node, a
 *    function, or a `Date` that happens to serialize on one engine and not
 *    another would make extraction results engine-dependent, so the rule is
 *    enforced here (see {@link assertJsonCompatible}) rather than left to
 *    whatever the driver does.
 */

/**
 * Whether model-authored page JavaScript may run in a browser session.
 * `deny` is enforced before the page is touched at all — not by inspecting
 * the submitted code, which is undecidable.
 */
export type BrowserJavaScriptPolicy = 'allow' | 'deny';

/**
 * Deadline applied when a caller names none. Short on purpose: an extraction
 * snippet reads a DOM that is already loaded, so seconds are generous, and a
 * low default means the common mistake (an accidental `while` or an `await`
 * that never settles) costs one turn instead of the run's wall clock.
 */
export const DEFAULT_JAVASCRIPT_TIMEOUT_MS = 5_000;

/**
 * Hard ceiling on any caller-supplied deadline. Callers above it are
 * *rejected*, not silently clamped: a snippet written for a 5-minute budget
 * behaves differently from one cut off at 30s, and telling the model its
 * budget was refused is cheaper than letting it believe a long job is still
 * running. Page JavaScript is not the right tool for long work — a slow job
 * belongs in repeated bounded calls.
 */
export const MAX_JAVASCRIPT_TIMEOUT_MS = 30_000;

/**
 * The early (T6) JavaScript request. `target` is a required literal, not an
 * optional page/frame id: T10 adds real page/frame/document targeting, and
 * an optional field now would silently mean "whatever is selected" in code
 * written against the later, explicit model.
 */
export interface EarlyJavaScriptRequest {
  /** The only target this early schema supports: the top document of the
   * currently selected page. */
  target: 'selected_top_document';
  /** Complete JavaScript to evaluate; its completion value is returned. */
  code: string;
  /** Already-clamped hard deadline in milliseconds. Never the raw
   * caller-supplied value — see the tool's timeout clamp. */
  timeoutMs: number;
}

/** The outcome of one successful page-JavaScript evaluation. */
export interface BrowserJavaScriptResult {
  /** The snippet's completion value, expected to be JSON-compatible; the
   * caller still verifies with {@link assertJsonCompatible} because the
   * engine's serializer is not the contract. */
  value: unknown;
  /** URL of the document the code actually ran in, read at call time — a
   * navigation between selection and execution shows up here. */
  url: string;
  /** Engine-scoped token for the document the code ran in, recorded in the
   * transcript and in evidence so an auditor can tell two calls against the
   * same-looking URL apart (a reload or a mid-run navigation changes it).
   * Opaque and NOT addressable — no tool accepts it as input; T9/T10 add the
   * stable page/frame/document ids that do. */
  documentToken: string;
  /** Console output captured during evaluation, oldest first. */
  logs: readonly string[];
}

/**
 * The narrow capability the `execute_javascript` tool needs from a browser
 * session. Kept minimal on purpose: the tool must not reach into page
 * selection, refs, or observation state, and a fake implementation of these
 * two methods is enough to test every branch of the tool hermetically.
 */
export interface JavaScriptCapablePage {
  /**
   * Evaluate code in the selected page's top document.
   *
   * @param code - the snippet to evaluate
   * @param timeoutMs - hard deadline; exceeding it must reject with
   *   {@link BrowserJavaScriptTimeoutError} rather than hang
   * @returns the completion value with the document's URL, its internal
   *   token, and captured console output. Rejects with
   *   {@link BrowserJavaScriptNonJsonError} when the engine cannot bring the
   *   value back as JSON, and with the page's own error for a snippet that
   *   throws.
   */
  evaluateJson(code: string, timeoutMs: number): Promise<BrowserJavaScriptResult>;
  /**
   * Discard a page whose JavaScript could not be terminated and replace it.
   *
   * A timed-out snippet may still be spinning: the page's event loop is not
   * trustworthy, so it is closed, its refs and observations are invalidated,
   * and a fresh page takes its place.
   *
   * @returns nothing; a usable page is selected again. Rejects only when
   *   even the replacement fails, which means the session itself is gone.
   */
  replaceUnresponsivePage(): Promise<void>;
}

/** Raised when page JavaScript exceeded its hard deadline. Terminating —
 * the caller must replace the page, never retry into the same one. */
export class BrowserJavaScriptTimeoutError extends Error {
  /** The deadline that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Page JavaScript exceeded its ${timeoutMs}ms limit and was terminated.`);
    this.name = 'BrowserJavaScriptTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when a snippet's completion value cannot cross the boundary as
 * JSON. Carries the offending location and type so the model can fix the
 * snippet instead of guessing. */
export class BrowserJavaScriptNonJsonError extends Error {
  /** Path to the offending value, e.g. `value.rows[2].node`. */
  readonly valuePath: string;
  /** What was found there, e.g. `function`, `undefined`, `NaN`, `Map`. */
  readonly valueType: string;

  constructor(valuePath: string, valueType: string) {
    super(
      `Page JavaScript returned a non-JSON value: ${valuePath} is ${valueType}. ` +
        `Return only JSON: strings, finite numbers, booleans, null, arrays, ` +
        `and plain objects — map DOM nodes to plain objects (e.g. ` +
        `{ text: el.textContent, href: el.href }) and dates to ISO strings.`,
    );
    this.name = 'BrowserJavaScriptNonJsonError';
    this.valuePath = valuePath;
    this.valueType = valueType;
  }
}

/** Nesting depth allowed in a returned value. Bounded so a self-referential
 * or pathologically deep structure cannot exhaust the stack during
 * validation; real extraction results are a handful of levels deep. */
export const MAX_JSON_VALUE_DEPTH = 32;

/**
 * Resolve the effective page-JavaScript policy for a session, failing at
 * configuration time when the decision was never made.
 *
 * An authenticated session runs code with a logged-in profile's authority,
 * so the operator must state `allow` or `deny` — inheriting a default there
 * would hide a real capability grant behind a convenience. An anonymous
 * session has no session to expose beyond the public page, so page
 * JavaScript defaults to `allow` and the tool stays useful out of the box.
 *
 * @param policy - the explicitly configured policy, or undefined when none
 *   was configured
 * @param isAuthenticated - whether the session carries logged-in state
 *   (persistent profile, stored cookies, or filled credentials)
 * @returns the policy to enforce for the whole session
 * @throws Error when an authenticated session has no explicit policy
 */
export function assertJavaScriptPolicy(
  policy: BrowserJavaScriptPolicy | undefined,
  isAuthenticated: boolean,
): BrowserJavaScriptPolicy {
  if (policy !== undefined) return policy;
  if (isAuthenticated) {
    throw new Error(
      `An authenticated browser session must set javascriptPolicy explicitly ` +
        `('allow' or 'deny'): model-authored page JavaScript runs with the ` +
        `logged-in profile's full authority, so the exposure has to be chosen, ` +
        `not defaulted.`,
    );
  }
  return 'allow';
}

/**
 * Describe a resolved policy for the run log.
 *
 * @param policy - the resolved policy
 * @param isAuthenticated - whether the session carries logged-in state
 * @returns one log line recording the decision. An `allow` on an
 *   authenticated session is stated as accepted capability exposure; the
 *   wording never calls page JavaScript a sandbox, because it is not one
 */
export function describeJavaScriptPolicyDecision(
  policy: BrowserJavaScriptPolicy,
  isAuthenticated: boolean,
): string {
  const session = isAuthenticated ? 'authenticated' : 'anonymous';
  if (policy === 'deny') {
    return `javascriptPolicy=deny (${session} session): execute_javascript will refuse every call.`;
  }
  return (
    `javascriptPolicy=allow (${session} session): accepted capability exposure — ` +
    `model-authored code runs with this page's full authority (cookies, session, ` +
    `same-origin reach). This is not a sandbox.`
  );
}

/**
 * Build the engine-level request for one early JavaScript call.
 *
 * @param code - the snippet to evaluate; must contain something to run
 * @param timeoutMs - the already-bounded deadline in milliseconds; must be a
 *   positive safe integer no greater than {@link MAX_JAVASCRIPT_TIMEOUT_MS}
 *   (safe-integer implies finite, so NaN and Infinity are rejected)
 * @returns the request naming the only T6 target, so the literal lives in
 *   exactly one place as T10 widens targeting
 * @throws TypeError for blank code, or a `timeoutMs` that is not a positive
 *   safe integer within the ceiling. These duplicate the tool's zod schema
 *   deliberately: this is the seam every future caller (batch tools,
 *   internal extraction helpers) reaches the engine through, and a seam that
 *   trusts its callers to have validated is a seam with no contract.
 */
export function toEarlyJavaScriptRequest(
  code: string,
  timeoutMs: number,
): EarlyJavaScriptRequest {
  if (code.trim() === '') {
    throw new TypeError('code must be a non-empty JavaScript snippet');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(`timeoutMs must be a positive safe integer: ${String(timeoutMs)}`);
  }
  if (timeoutMs > MAX_JAVASCRIPT_TIMEOUT_MS) {
    throw new TypeError(
      `timeoutMs must be at most ${MAX_JAVASCRIPT_TIMEOUT_MS}ms: ${String(timeoutMs)}`,
    );
  }
  return { target: 'selected_top_document', code, timeoutMs };
}

/**
 * Verify that a value returned by page JavaScript is JSON-compatible.
 *
 * Accepts exactly what deterministic extraction needs: `null`, booleans,
 * finite numbers, strings, arrays, and plain objects (prototype
 * `Object.prototype` or `null`), nested at most
 * {@link MAX_JSON_VALUE_DEPTH} deep. Everything else is rejected by name —
 * including values that *would* survive `JSON.stringify` (`Date`, a class
 * instance with `toJSON`) — because "it serialized on this engine" is not a
 * contract the run can depend on, and because a silently dropped key is far
 * more expensive to debug than a rejected call.
 *
 * @param value - the completion value to check
 * @param label - path prefix used in the error message; defaults to `value`
 * @returns nothing when the value is JSON-compatible
 * @throws BrowserJavaScriptNonJsonError naming the first offending path and
 *   its type; the message is bounded (a type name and a path, never the
 *   value itself), so a huge page value cannot flood the transcript
 */
export function assertJsonCompatible(value: unknown, label = 'value'): void {
  // Ancestor set, not a global seen-set: repeating the same object in two
  // sibling positions is legal JSON, only a cycle through an ancestor is not.
  assertJsonCompatibleAt(value, label, 0, new Set<object>());
}

function assertJsonCompatibleAt(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (value === null) return;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return;
    case 'number':
      // NaN and ±Infinity stringify to `null`, turning a broken measurement
      // into a plausible-looking absent one.
      if (!Number.isFinite(value)) {
        throw new BrowserJavaScriptNonJsonError(path, String(value));
      }
      return;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint. The "returned nothing" hint is
      // only true at the root — a nested undefined means a key JSON would
      // have dropped silently, which is a different mistake and gets no
      // misleading advice.
      throw new BrowserJavaScriptNonJsonError(
        path,
        value !== undefined
          ? typeof value
          : depth === 0
            ? // Names the two forms that actually work. The old wording said
              // "end it with the value itself, or a return inside an IIFE" —
              // both of which returned undefined under the old wrapping, so
              // the advice sent the model in circles for 15 straight calls.
              'undefined (the snippet produced no value — either make the whole ' +
              'snippet a single expression, e.g. `document.title`, or use an ' +
              'explicit top-level `return` after your statements; a bare ' +
              'expression as the LAST statement of a multi-statement snippet ' +
              'is not returned)'
            : 'undefined (JSON would drop this key silently; omit it or use null)',
      );
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new BrowserJavaScriptNonJsonError(path, 'a circular reference');
  }
  if (depth >= MAX_JSON_VALUE_DEPTH) {
    throw new BrowserJavaScriptNonJsonError(
      path,
      `nested deeper than ${MAX_JSON_VALUE_DEPTH} levels`,
    );
  }

  ancestors.add(object);
  if (Array.isArray(object)) {
    object.forEach((element, index) => {
      assertJsonCompatibleAt(element, `${path}[${index}]`, depth + 1, ancestors);
    });
  } else if (isPlainObject(object)) {
    for (const [key, entry] of Object.entries(object)) {
      assertJsonCompatibleAt(entry, `${path}.${key}`, depth + 1, ancestors);
    }
  } else {
    throw new BrowserJavaScriptNonJsonError(path, describeExoticObject(object));
  }
  ancestors.delete(object);
}

/** True for object literals and null-prototype objects — the only object
 * shapes whose JSON form is fully determined by their own keys. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Name a rejected object by constructor (`Date`, `Map`, `Element`, ...),
 * falling back to a generic label. Bounded: a constructor name, never the
 * object's contents. */
function describeExoticObject(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name !== ''
    ? `a ${name} instance, which has no guaranteed JSON form`
    : 'an object with no guaranteed JSON form';
}
