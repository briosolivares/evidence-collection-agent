import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserbaseErrorStatus,
  isRetryableBrowserbaseError,
  retryAfterMs,
  withBrowserbaseRetry,
} from '../../src/browser/browserbaseRetry.js';

/** A fake HTTP-ish failure: `status` and `headers` are duck-typed by the
 * module under test, so this is all a real APIError or fetch failure needs
 * to look like. */
function httpError(status: number, headers?: Record<string, string> | Headers): Error {
  return Object.assign(new Error(`browserbase http ${status}`), { status, headers });
}

/** Records every requested delay and resolves immediately — no real timer
 * ever runs, so the suite stays instant regardless of the backoff schedule
 * it is pinning. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

/** Fails a fixed number of times before succeeding, so a test can name the
 * exact attempt where the operation starts working. */
function failThenSucceed<T>(failures: Error[], result: T): (attempt: number) => Promise<T> {
  let index = 0;
  return async () => {
    if (index < failures.length) {
      const error = failures[index];
      index += 1;
      throw error;
    }
    return result;
  };
}

describe('withBrowserbaseRetry', () => {
  it('returns the value on first success without sleeping at all', async () => {
    const { sleep, calls } = fakeSleep();
    const operation = vi.fn(async () => 'ok');

    await expect(withBrowserbaseRetry('probe', operation, { sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('retries a 429 and succeeds later, pinning the exponential schedule', async () => {
    const { sleep, calls } = fakeSleep();
    const operation = failThenSucceed([httpError(429), httpError(429), httpError(429)], 'ok');

    // Default maxAttempts is 4: three 429s, then a success on the fourth try.
    await expect(withBrowserbaseRetry('list downloads', operation, { sleep })).resolves.toBe('ok');
    // 500ms, 1000ms, 2000ms — the doubling schedule, not merely "it waited".
    expect(calls).toEqual([500, 1000, 2000]);
  });

  it('honors Retry-After in delay-seconds form when it exceeds the computed backoff', async () => {
    const { sleep, calls } = fakeSleep();
    // Attempt 1's backoff is 500ms; a 5s Retry-After must win (the max of the two).
    const operation = failThenSucceed([httpError(429, { 'retry-after': '5' })], 'ok');

    await withBrowserbaseRetry('probe', operation, { sleep });
    expect(calls).toEqual([5_000]);
  });

  it('ignores Retry-After when it is shorter than the computed backoff', async () => {
    const { sleep, calls } = fakeSleep();
    // Attempt 1's backoff is 500ms; a 0s Retry-After must not shrink it.
    const operation = failThenSucceed([httpError(429, { 'retry-after': '0' })], 'ok');

    await withBrowserbaseRetry('probe', operation, { sleep });
    expect(calls).toEqual([500]);
  });

  it('honors Retry-After in HTTP-date form', async () => {
    const fixedNow = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const { sleep, calls } = fakeSleep();
      const at = new Date(fixedNow + 3_000).toUTCString();
      const operation = failThenSucceed([httpError(429, { 'retry-after': at })], 'ok');

      await withBrowserbaseRetry('probe', operation, { sleep });
      // 3s from `now`, comfortably above attempt 1's 500ms backoff.
      expect(calls).toEqual([3_000]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('caps a single wait at the module maximum even when Retry-After asks for much more', async () => {
    const { sleep, calls } = fakeSleep();
    const operation = failThenSucceed([httpError(429, { 'retry-after': '3600' })], 'ok');

    await withBrowserbaseRetry('probe', operation, { sleep });
    expect(calls).toEqual([8_000]);
  });

  it('does not retry 401, surfacing it immediately with no sleep', async () => {
    const { sleep, calls } = fakeSleep();
    const error = httpError(401);
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(withBrowserbaseRetry('probe', operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('retries a transport failure that carries no status at all', async () => {
    const { sleep, calls } = fakeSleep();
    const transportError = new Error('socket hang up');
    const operation = failThenSucceed([transportError], 'ok');

    await expect(withBrowserbaseRetry('probe', operation, { sleep })).resolves.toBe('ok');
    expect(calls).toEqual([500]);
  });

  it('exhausts maxAttempts and rethrows the LAST error, not the first', async () => {
    const { sleep } = fakeSleep();
    const first = httpError(500);
    const last = httpError(500);
    const operation = vi.fn(async (attempt: number) => {
      throw attempt === 1 ? first : last;
    });

    await expect(withBrowserbaseRetry('probe', operation, { sleep, maxAttempts: 3 })).rejects.toBe(
      last,
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('reports one onRetry message per retry, with no API key or URL inside', async () => {
    const { sleep } = fakeSleep();
    const apiKey = 'bb_live_super_secret_key';
    const url = 'https://api.browserbase.com/v1/downloads?sessionId=abc';
    const messages: string[] = [];
    const operation = failThenSucceed([httpError(429), httpError(429)], 'ok');

    await withBrowserbaseRetry('list downloads', operation, {
      sleep,
      onRetry: (message) => messages.push(message),
    });

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain(apiKey);
      expect(message).not.toContain(url);
      expect(message).not.toContain('http');
    }
  });
});

describe('isRetryableBrowserbaseError', () => {
  it('retries 408, 409, 429, and every 5xx', () => {
    for (const status of [408, 409, 429, 500, 502, 503]) {
      expect(isRetryableBrowserbaseError(httpError(status))).toBe(true);
    }
  });

  it('does not retry 401, 403, or an arbitrary 4xx describing the request', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableBrowserbaseError(httpError(status))).toBe(false);
    }
  });

  it('retries a status-less failure', () => {
    expect(isRetryableBrowserbaseError(new Error('boom'))).toBe(true);
  });
});

describe('browserbaseErrorStatus', () => {
  it('reads a numeric status off a plain-object-shaped error', () => {
    expect(browserbaseErrorStatus(httpError(429))).toBe(429);
  });

  it('is undefined for a transport failure with no status', () => {
    expect(browserbaseErrorStatus(new Error('boom'))).toBeUndefined();
    expect(browserbaseErrorStatus(null)).toBeUndefined();
    expect(browserbaseErrorStatus(undefined)).toBeUndefined();
  });
});

describe('retryAfterMs', () => {
  const now = 1_700_000_000_000;

  it('reads delay-seconds from a plain-object headers bag', () => {
    expect(retryAfterMs(httpError(429, { 'retry-after': '2' }), now)).toBe(2_000);
  });

  it('reads delay-seconds from a real Headers instance', () => {
    expect(retryAfterMs(httpError(429, new Headers({ 'retry-after': '2' })), now)).toBe(2_000);
  });

  it('reads an HTTP-date from a plain-object headers bag', () => {
    const at = new Date(now + 4_000).toUTCString();
    expect(retryAfterMs(httpError(429, { 'retry-after': at }), now)).toBe(4_000);
  });

  it('is undefined when there is no Retry-After header at all', () => {
    expect(retryAfterMs(httpError(429), now)).toBeUndefined();
    expect(retryAfterMs(httpError(429, {}), now)).toBeUndefined();
    expect(retryAfterMs(httpError(429, new Headers()), now)).toBeUndefined();
  });
});
