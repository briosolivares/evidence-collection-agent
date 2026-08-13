import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';

// Manual retry around one whole model call — stream creation AND
// consumption. The SDK's built-in retry covers only the initial POST;
// mid-stream SSE `error` events (overloaded_error killed a full eval
// attempt — docs/reports/2026-08-11-medium-rebaseline.md) and dropped
// connections throw out of the stream iteration unretried. So both
// production call sites construct their client with `maxRetries: 0`
// (makeAnthropicClient) and wrap create + assemble in callWithRetry: one
// retry authority, Claude Code's approach at harness scale. Retries are
// nearly free: a retried request is byte-identical, so it re-reads the
// prompt cache the failed attempt already wrote.

/** Total attempts per model call: the first try plus up to three retries. */
export const MAX_CALL_ATTEMPTS = 4;

/** Base backoff before retry n (1-indexed); jittered ±50%. */
const BACKOFF_BASE_MS = [1_000, 2_000, 4_000] as const;

/** Longest server-requested retry-after honored, in milliseconds. */
const MAX_RETRY_AFTER_MS = 60_000;

/** What onRetry learns about each scheduled retry. */
export interface RetryInfo {
  /** The attempt about to run, 2..MAX_CALL_ATTEMPTS. */
  attempt: number;
  /** How long the loop will sleep before that attempt. */
  delayMs: number;
  /** Short classification of the failure being retried, e.g.
   * "overloaded_error", "HTTP 529", "connection error". */
  reason: string;
}

/** Options for callWithRetry; all optional. */
export interface CallWithRetryOptions {
  /** Cancellation: an abort rejects immediately — mid-attempt failures stop
   * retrying, and a backoff sleep is cut short with an AbortError. */
  signal?: AbortSignal;
  /** Notified before each backoff sleep (progress surfaces print it). */
  onRetry?: (info: RetryInfo) => void;
  /** Test seam: replaces the abortable backoff sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: replaces the jitter source; must return a value in [0, 1). */
  random?: () => number;
}

/**
 * Run one model-call attempt, retrying transient failures.
 *
 * Retryable: APIConnectionError; APIError with status 408, 409, 429, or
 * >= 500 (529 included); an APIError without a status whose type is
 * `overloaded_error` or `api_error` (how the SDK surfaces a mid-stream SSE
 * `error` event); and TruncatedStreamError from stream assembly (the
 * connection died mid-stream). Never retried: aborts (an AbortError or
 * APIUserAbortError propagates immediately, and any failure observed after
 * opts.signal aborted is treated as the abort it is); other 4xx (invalid
 * request, auth, not-found); and deterministic assembly errors — retrying
 * those would only reproduce them.
 *
 * Backoff between attempts is 1s / 2s / 4s with ±50% jitter; an error
 * carrying a numeric retry-after header replaces the backoff, capped at
 * 60s.
 *
 * @param attempt - performs one complete attempt (create the stream AND
 *   consume it to a ModelResponse); called up to MAX_CALL_ATTEMPTS times
 * @param opts - see CallWithRetryOptions
 * @returns the first successful attempt's result
 * @throws the first non-retryable error, or the last error once attempts
 *   are exhausted, unchanged either way
 */
export async function callWithRetry<T>(
  attempt: () => Promise<T>,
  opts: CallWithRetryOptions = {},
): Promise<T> {
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      // An abort is never retried — cancellation must propagate now, and a
      // failure observed after abort (e.g. truncation from a killed stream)
      // is the abort wearing a costume.
      if (opts.signal?.aborted || isAbortError(error)) throw error;
      const reason = transientReason(error);
      if (reason === undefined || attemptNumber >= MAX_CALL_ATTEMPTS) throw error;
      const delayMs = retryDelayMs(error, attemptNumber, random);
      opts.onRetry?.({ attempt: attemptNumber + 1, delayMs, reason });
      await sleep(delayMs, opts.signal);
    }
  }
}

/** Whether this failure is transient, and if so how to describe it;
 * undefined means don't retry (see callWithRetry). */
function transientReason(error: unknown): string | undefined {
  // Stream truncation is classified by error name, not message regex —
  // streamAssembly gives its two truncation throws this name and leaves
  // its deterministic throws as plain Errors. The where-it-died summary
  // rides along so retried-and-recovered truncations still leave a trace
  // in the progress log.
  if (error instanceof Error && error.name === 'TruncatedStreamError') {
    const summary = (error as { diagnosticsSummary?: string }).diagnosticsSummary;
    return summary === undefined ? 'truncated stream' : `truncated stream (${summary})`;
  }
  if (error instanceof APIConnectionError) return 'connection error';
  if (error instanceof APIError) {
    if (typeof error.status === 'number') {
      const retryable =
        error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        error.status >= 500;
      return retryable ? `HTTP ${error.status}` : undefined;
    }
    // No status: the SDK throws these for mid-stream SSE `error` events,
    // with `type` carrying the event's error type.
    return error.type === 'overloaded_error' || error.type === 'api_error'
      ? error.type
      : undefined;
  }
  return undefined;
}

/** Cancellation in any of its shapes: the SDK's abort error class, or the
 * conventional name (the TUI bridge throws Errors named AbortError). */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** The delay before the next attempt: the error's numeric retry-after when
 * it carries one (capped at MAX_RETRY_AFTER_MS), else jittered backoff. */
function retryDelayMs(error: unknown, attemptNumber: number, random: () => number): number {
  if (error instanceof APIError) {
    const header = error.headers?.get('retry-after');
    if (header !== undefined && header !== null) {
      const seconds = Number(header.trim());
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }
    }
  }
  const base = BACKOFF_BASE_MS[Math.min(attemptNumber, BACKOFF_BASE_MS.length) - 1]!;
  return Math.round(base * (0.5 + random()));
}

/** setTimeout-based sleep that rejects with an AbortError the moment the
 * signal aborts — a cancelled run must not wait out a backoff. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  return Object.assign(new Error('model call aborted during retry backoff'), {
    name: 'AbortError',
  });
}
