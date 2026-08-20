import { describe, expect, it } from 'vitest';

import { fetchWithRetry, MAX_FETCH_ATTEMPTS, type FetchRetryDeps } from './fetchWithRetry.js';

// Hermetic throughout: every test injects fetch and sleep — no live HTTP,
// no real timers. random is pinned to 0.5 so jittered backoff equals the
// base delay exactly (base * (0.5 + 0.5)).

/** A canned response; body content is irrelevant to the retry logic. */
function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

/** Deps whose fetch serves the given outcomes in order (a thrown Error or a
 * returned Response), recording every backoff the loop requests. */
function scriptedDeps(outcomes: Array<Error | Response>): {
  deps: FetchRetryDeps;
  calls: () => number;
  sleeps: number[];
} {
  let calls = 0;
  const sleeps: number[] = [];
  const deps: FetchRetryDeps = {
    fetchFn: (() => {
      const outcome = outcomes[calls];
      calls += 1;
      if (outcome === undefined) {
        throw new Error(`fetch called ${calls} times but only ${outcomes.length} scripted`);
      }
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    }) as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  };
  return { deps, calls: () => calls, sleeps };
}

describe('fetchWithRetry', () => {
  it('returns a first-attempt success without sleeping', async () => {
    const { deps, calls, sleeps } = scriptedDeps([response(200)]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(200);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('succeeds after two network rejections, backing off 1s then 2s', async () => {
    const { deps, calls, sleeps } = scriptedDeps([
      new Error('fetch failed'),
      new Error('fetch failed'),
      response(200),
    ]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.ok).toBe(true);
    expect(calls()).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('retries a 503 then returns the success', async () => {
    const { deps, sleeps } = scriptedDeps([response(503), response(200)]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(200);
    expect(sleeps).toEqual([1_000]);
  });

  it('retries a plain 429', async () => {
    const { deps, sleeps } = scriptedDeps([response(429), response(200)]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(200);
    expect(sleeps).toEqual([1_000]);
  });

  it('does not retry a 404 — other 4xx fail fast', async () => {
    const { deps, calls, sleeps } = scriptedDeps([response(404)]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(404);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('honors a small Retry-After verbatim instead of the backoff', async () => {
    const { deps, sleeps } = scriptedDeps([response(503, { 'retry-after': '7' }), response(200)]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(200);
    expect(sleeps).toEqual([7_000]);
  });

  it('fails fast on a Retry-After over 30s — grading must not hang', async () => {
    const { deps, calls, sleeps } = scriptedDeps([response(503, { 'retry-after': '3600' })]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(503);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after 4 attempts, throwing the last network error', async () => {
    const errors = [1, 2, 3, 4].map((n) => new Error(`fetch failed #${n}`));
    const { deps, calls, sleeps } = scriptedDeps(errors);
    await expect(fetchWithRetry('https://example.test/x', undefined, deps)).rejects.toBe(errors[3]);
    expect(calls()).toBe(MAX_FETCH_ATTEMPTS);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('returns the final response when every attempt is a retryable status', async () => {
    const { deps, calls, sleeps } = scriptedDeps([
      response(503),
      response(503),
      response(503),
      response(503),
    ]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(503);
    expect(calls()).toBe(MAX_FETCH_ATTEMPTS);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('does not retry an exhausted rate-limit 429 — the raise-the-limit path stays intact', async () => {
    // githubGetJson turns this response into its "set GITHUB_TOKEN" error;
    // returning it unretried on attempt 1 is what preserves that message.
    const { deps, calls, sleeps } = scriptedDeps([response(429, { 'x-ratelimit-remaining': '0' })]);
    const result = await fetchWithRetry('https://example.test/x', undefined, deps);
    expect(result.status).toBe(429);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
