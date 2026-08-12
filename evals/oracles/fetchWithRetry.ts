// Bounded retries on transient failures for oracle HTTP fetches. Motivated
// by eval attempts dying mid-grading on a bare fetch()'s "fetch failed"
// (docs/reports/2026-08-11-medium-rebaseline.md): a trial that had already
// spent its whole model budget was lost to one network blip. The shape
// follows Claude Code's manual retry loop at harness scale — few attempts,
// exponential backoff with jitter, Retry-After honored within reason.

/** Total attempts per fetch: the first try plus up to three retries. */
export const MAX_FETCH_ATTEMPTS = 4;

/** Base backoff before retry n (1-indexed); jittered ±50%. */
const BACKOFF_BASE_MS = [1_000, 2_000, 4_000] as const;

/** Longest server-requested Retry-After honored, in seconds. Grading should
 * fail fast rather than hang on a server asking for a long pause — a reset
 * an hour away is not a transient. */
const MAX_RETRY_AFTER_SECONDS = 30;

/** Injection seams so the test suite never touches live HTTP or real time. */
export interface FetchRetryDeps {
  /** Replaces global fetch. */
  fetchFn?: typeof fetch;
  /** Replaces the backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the jitter source; must return a value in [0, 1). */
  random?: () => number;
}

/**
 * fetch, retried on transient failures.
 *
 * Retryable: a thrown fetch error (network — "fetch failed", ECONNRESET,
 * DNS) and responses with status 408, 429, or >= 500. Everything else —
 * success, other 4xx, and a 429 whose x-ratelimit-remaining is exhausted
 * (a GitHub rate-limit reset is typically an hour away, and the caller's
 * raise-the-limit message must survive) — is returned as-is on the first
 * attempt that produces it.
 *
 * Backoff between attempts is 1s / 2s / 4s with ±50% jitter. A numeric
 * Retry-After header replaces the backoff when present and <=
 * MAX_RETRY_AFTER_SECONDS; a longer one fails fast (the response is
 * returned, not slept on).
 *
 * @param url - the URL to GET (or whatever `init` says)
 * @param init - standard fetch options, passed through unchanged
 * @param deps - test seams (see FetchRetryDeps); production callers omit it
 * @returns the first non-retryable response, or the last response after
 *   MAX_FETCH_ATTEMPTS
 * @throws the last network error when every attempt threw
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  deps: FetchRetryDeps = {},
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      if (attempt >= MAX_FETCH_ATTEMPTS) throw error;
      await sleep(jitteredBackoffMs(attempt, random));
      continue;
    }

    if (!isRetryableResponse(response) || attempt >= MAX_FETCH_ATTEMPTS) return response;

    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
    if (retryAfterSeconds !== undefined && retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
      return response;
    }
    await sleep(
      retryAfterSeconds !== undefined
        ? retryAfterSeconds * 1000
        : jitteredBackoffMs(attempt, random),
    );
  }
}

/** Whether this response is worth another attempt (see fetchWithRetry). */
function isRetryableResponse(response: Response): boolean {
  if (response.ok) return false;
  // Exhausted rate limit: not a transient (403 is already non-retryable
  // below; this catches the 429 form) — fail fast so the caller's
  // raise-the-limit error message reaches the operator unchanged.
  if (response.status === 429 && response.headers.get('x-ratelimit-remaining') === '0') {
    return false;
  }
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

/** The Retry-After header as seconds; undefined when absent or not the
 * numeric-seconds form (the HTTP-date form falls back to backoff). */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Backoff before retry `attempt`+1: the attempt's base delay ±50%. */
function jitteredBackoffMs(attempt: number, random: () => number): number {
  const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length) - 1]!;
  return Math.round(base * (0.5 + random()));
}
