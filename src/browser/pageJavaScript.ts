import type { Page } from 'playwright';

import {
  BrowserJavaScriptNonJsonError,
  BrowserJavaScriptTimeoutError,
  type BrowserJavaScriptResult,
  type EarlyJavaScriptRequest,
} from './browserJavaScript.js';
import { evaluationSources, parses } from './playwrightBrowserController.js';

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
 * Await one evaluation against the Node-side deadline.
 *
 * Extracted so the expression/statement attempts share exactly one timeout
 * implementation — see {@link evaluateJavaScript}'s note on why the deadline
 * is terminal and the losing evaluation is abandoned unawaited.
 */
async function raceEvaluation(
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
 * Mechanics behind `PlaywrightBrowserController.executeJavaScript` (T6),
 * given an already-resolved `page` (the controller resolves the requested
 * `pageId`, or the selected page when omitted, and locks it in BEFORE
 * calling this, so a navigation mid-call cannot move execution to a
 * different document than the one whose URL and token are reported).
 * Console output is captured for the duration of the call only.
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
 *
 * `withRendererDeadline` is passed in as a bound closure — not the
 * controller instance — so this module never reaches into controller-private
 * state (the busy registry an abandoned read is registered against) directly;
 * see the controller's own `withRendererDeadline` method for what it
 * protects.
 */
export async function evaluateJavaScript(
  page: Page,
  request: EarlyJavaScriptRequest,
  withRendererDeadline: <T>(
    read: () => Promise<T>,
    timeoutMs: number,
    fallback?: T,
    pageId?: string,
  ) => Promise<T>,
  rendererReadTimeoutMs: number,
): Promise<BrowserJavaScriptResult> {
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
    const documentToken = await withRendererDeadline(
      () =>
        page.evaluate(
          `(() => { const w = globalThis; w.__sherlockDoc ??= 'doc-' + Math.random().toString(36).slice(2, 10); return w.__sherlockDoc; })()`,
        ),
      rendererReadTimeoutMs,
      undefined,
      request.pageId,
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
          value = await raceEvaluation(page, sources[attempt]!, request.timeoutMs);
          break;
        } catch (error) {
          // Fall through to statement semantics ONLY when THIS candidate
          // never actually parsed: that alone proves nothing executed, so
          // re-running cannot repeat a side effect. A runtime error means
          // the snippet already ran, and silently running it a second
          // time could double-submit a form.
          //
          // Deciding this from the error's MESSAGE (isSyntaxErrorLike)
          // rather than by re-checking whether the candidate parses is
          // unsound: evaluationSources already parse-checks asExpression
          // and asCompletionValue with `parses()` before ever including
          // them, so by the time either one reaches this catch, we
          // already know it parsed — any error it throws, even one whose
          // message happens to match /SyntaxError|Unexpected token/ (e.g.
          // the snippet's own `JSON.parse(bad)`), is a genuine runtime
          // failure. `parses()` re-answers the real question — did THIS
          // exact wrapped source fail to parse at all — using the same
          // Node/V8 check evaluationSources itself relies on, instead of
          // pattern-matching a message that can't tell the two apart.
          const canRetry = attempt < sources.length - 1 && !parses(sources[attempt]!);
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
