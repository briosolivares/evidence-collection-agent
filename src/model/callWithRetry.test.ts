import { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  callWithRetry,
  MAX_CALL_ATTEMPTS,
  MAX_TRUNCATED_STREAM_ATTEMPTS,
  type RetryInfo,
} from './callWithRetry.js';
import { TruncatedStreamError } from './streamAssembly.js';

// Hermetic throughout: sleep is injected everywhere except the abort test
// (which exercises the real abortable sleep, cut short in milliseconds).
// random is pinned to 0.5 so jittered backoff equals the base delay.

/** An attempt that fails with each scripted error, then succeeds. */
function flakyAttempt<T>(failures: unknown[], value: T): { attempt: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    attempt: () => {
      calls += 1;
      const failure = failures[calls - 1];
      return failure === undefined ? Promise.resolve(value) : Promise.reject(failure);
    },
    calls: () => calls,
  };
}

/** Options with a recording sleep and pinned jitter. */
function recordingOpts(): {
  opts: { sleep: (ms: number) => Promise<void>; random: () => number; onRetry: (info: RetryInfo) => void };
  sleeps: number[];
  retries: RetryInfo[];
} {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  return {
    opts: {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      onRetry: (info) => retries.push(info),
    },
    sleeps,
    retries,
  };
}

/** A mid-stream SSE error as the SDK throws it: APIError without a status,
 * `type` carrying the SSE event's error type. */
function sseError(type: 'overloaded_error' | 'api_error'): APIError {
  return new APIError(
    undefined,
    { type: 'error', error: { type, message: 'upstream unhappy' } },
    undefined,
    undefined,
    type,
  );
}

describe('callWithRetry', () => {
  it('returns a first-attempt success without retrying', async () => {
    const { opts, sleeps } = recordingOpts();
    const { attempt, calls } = flakyAttempt([], 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries a connection error and reports it to onRetry', async () => {
    const { opts, sleeps, retries } = recordingOpts();
    const { attempt, calls } = flakyAttempt([new APIConnectionError({})], 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([1_000]);
    expect(retries).toEqual([
      { attempt: 2, maxAttempts: MAX_CALL_ATTEMPTS, delayMs: 1_000, reason: 'connection error' },
    ]);
  });

  it('retries a 529 APIError with exponential backoff until success', async () => {
    const overloaded = new APIError(529, undefined, 'Overloaded', undefined, 'overloaded_error');
    const { opts, sleeps, retries } = recordingOpts();
    const { attempt, calls } = flakyAttempt([overloaded, overloaded], 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(retries.map((r) => r.reason)).toEqual(['HTTP 529', 'HTTP 529']);
  });

  it('retries a mid-stream SSE overloaded_error (no HTTP status)', async () => {
    const { opts, retries } = recordingOpts();
    const { attempt } = flakyAttempt([sseError('overloaded_error')], 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(retries).toEqual([
      { attempt: 2, maxAttempts: MAX_CALL_ATTEMPTS, delayMs: 1_000, reason: 'overloaded_error' },
    ]);
  });

  it('retries a TruncatedStreamError from stream assembly', async () => {
    const { opts, retries } = recordingOpts();
    const { attempt } = flakyAttempt(
      [new TruncatedStreamError('model stream ended without a message_start event')],
      'ok',
    );
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(retries.map((r) => r.reason)).toEqual(['truncated stream']);
  });

  it('passes a non-retryable 4xx through on attempt 1', async () => {
    const badRequest = new APIError(400, undefined, 'invalid request', undefined, 'invalid_request_error');
    const { opts, sleeps } = recordingOpts();
    const { attempt, calls } = flakyAttempt([badRequest, badRequest, badRequest, badRequest], 'never');
    await expect(callWithRetry(attempt, opts)).rejects.toBe(badRequest);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('passes a deterministic assembly error through on attempt 1', async () => {
    const deterministic = new Error(
      'unsupported content block type "thinking" in model stream — the loop carries only text and tool_use blocks',
    );
    const { opts } = recordingOpts();
    const { attempt, calls } = flakyAttempt([deterministic], 'never');
    await expect(callWithRetry(attempt, opts)).rejects.toBe(deterministic);
    expect(calls()).toBe(1);
  });

  it('gives up after 4 attempts, rethrowing the last error unchanged', async () => {
    const dead = new APIConnectionError({ message: 'Connection error.' });
    const { opts, sleeps } = recordingOpts();
    const { attempt, calls } = flakyAttempt([dead, dead, dead, dead, dead], 'never');
    await expect(callWithRetry(attempt, opts)).rejects.toBe(dead);
    expect(calls()).toBe(MAX_CALL_ATTEMPTS);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('gives truncated streams the higher ceiling: survives 7 stalls and succeeds on attempt 8', async () => {
    // The decode stall is probabilistic per attempt (~6% measured), so
    // truncation gets patience nothing else does. Backoff past the table
    // reuses its last entry (4s).
    const stall = new TruncatedStreamError('response is truncated');
    const { opts, sleeps } = recordingOpts();
    const { attempt, calls } = flakyAttempt(Array(7).fill(stall), 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(calls()).toBe(MAX_TRUNCATED_STREAM_ATTEMPTS);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
  });

  it('gives up on truncation after 8 attempts, rethrowing the last error unchanged', async () => {
    const stall = new TruncatedStreamError('response is truncated');
    const { opts } = recordingOpts();
    const { attempt, calls } = flakyAttempt(Array(9).fill(stall), 'never');
    await expect(callWithRetry(attempt, opts)).rejects.toBe(stall);
    expect(calls()).toBe(MAX_TRUNCATED_STREAM_ATTEMPTS);
  });

  it('the higher ceiling is for the stall only: a late non-truncation failure ends the call', async () => {
    // Four truncations then a connection error on attempt 5: the failure
    // just observed is judged by its own class's ceiling (4), so the call
    // ends even though truncation would have kept retrying.
    const stall = new TruncatedStreamError('response is truncated');
    const dead = new APIConnectionError({ message: 'Connection error.' });
    const { opts } = recordingOpts();
    const { attempt, calls } = flakyAttempt([stall, stall, stall, stall, dead], 'never');
    await expect(callWithRetry(attempt, opts)).rejects.toBe(dead);
    expect(calls()).toBe(5);
  });

  it('honors a numeric retry-after header, capped at 60s', async () => {
    const politeError = new APIError(
      429,
      undefined,
      'rate limited',
      new Headers({ 'retry-after': '5' }),
      'rate_limit_error',
    );
    const pushyError = new APIError(
      529,
      undefined,
      'Overloaded',
      new Headers({ 'retry-after': '90' }),
      'overloaded_error',
    );
    const { opts, sleeps } = recordingOpts();
    const { attempt } = flakyAttempt([politeError, pushyError], 'ok');
    await expect(callWithRetry(attempt, opts)).resolves.toBe('ok');
    expect(sleeps).toEqual([5_000, 60_000]);
  });

  it('an abort during backoff rejects immediately with an AbortError', async () => {
    // Uses the real abortable sleep: backoff would be 1s, the abort lands
    // in milliseconds, and the rejection must not wait out the timer.
    const controller = new AbortController();
    let calls = 0;
    const promise = callWithRetry(
      () => {
        calls += 1;
        return Promise.reject(new APIConnectionError({}));
      },
      { signal: controller.signal, random: () => 0.5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('a failure observed after abort propagates immediately, even a retryable one', async () => {
    // A killed stream often surfaces as truncation; once the signal has
    // aborted, that must count as cancellation, not a retryable transient.
    const controller = new AbortController();
    const truncation = new TruncatedStreamError('response is truncated');
    let calls = 0;
    await expect(
      callWithRetry(
        () => {
          calls += 1;
          controller.abort();
          return Promise.reject(truncation);
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(truncation);
    expect(calls).toBe(1);
  });
});
