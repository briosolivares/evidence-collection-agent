/**
 * Cancellation guard for a model-call driver.
 *
 * Owns {@link withCancellationGuard}, split into its own file because three
 * clusters need it — the worker's production `callModel`, the initializer's
 * driver, and the verifier's driver, in both `runTask` and `resumeTask` — and
 * giving it a home inside any one of those clusters' own files would make the
 * other two import from a file that is not really about them, creating an
 * import cycle.
 */
import type { CallModel } from '../loop/messages.js';

/**
 * Wrap ONE production model client (never a caller-supplied `callModel` /
 * `harness.*CallModel` — those are the caller's own responsibility, exactly
 * as before) so cancellation is watertight regardless of which role's
 * client it is:
 *
 * 1. An already-aborted signal refuses a new call before dispatch, instead
 *    of relying on the request itself to notice. Without this, a turn the
 *    loop scheduled just before `signal.abort()` fires still puts a whole
 *    request on the wire — and, worse, a `createStream` test fixture
 *    written to settle only once it observes the signal would hang forever
 *    on a call it never receives a signal into at all when this guard
 *    isn't the one refusing it.
 * 2. Any failure observed once the signal IS aborted is normalized to a
 *    `name: 'AbortError'` Error, regardless of its original shape. Not
 *    cosmetic: `workerSession.ts`'s cancellation carve-out (a cancelled run
 *    gets no failed-metrics "crash" bookkeeping) and `runVerifier`'s "only
 *    an AbortError propagates, everything else becomes
 *    verifier_unavailable" rule both key off exactly that name — the
 *    Anthropic SDK's own abort error keeps the default 'Error', and a
 *    killed stream can surface as a truncation error instead. Without this,
 *    a plain cancellation could be bookkept as a worker crash, or reported
 *    as a verifier defect instead of propagating as the cancellation it is.
 */
export function withCancellationGuard(callModel: CallModel, signal: AbortSignal | undefined): CallModel {
  if (signal === undefined) return callModel;
  return async (messages) => {
    if (signal.aborted) {
      throw Object.assign(new Error('run cancelled'), { name: 'AbortError' });
    }
    return callModel(messages).catch((error: unknown) => {
      if (signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        throw Object.assign(new Error('run cancelled'), { name: 'AbortError' });
      }
      throw error;
    });
  };
}
