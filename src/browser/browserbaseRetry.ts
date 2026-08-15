/**
 * Bounded retry for Browserbase HTTP calls.
 *
 * One policy, used by every Browserbase request this codebase makes — session
 * create, session release, download list/fetch. The vendor SDK ships its own
 * retry, which is deliberately turned OFF where the client is constructed so
 * there is exactly one place that decides what "transient" means and how long
 * a batch is willing to wait for it.
 *
 * What is retried: 429 (concurrency limits are a normal condition when an
 * eval batch opens sessions in parallel), 408/409/5xx, and transport failures
 * with no status at all. What is NOT retried: 401/403 (a bad or missing API
 * key never becomes valid by waiting) and 4xx that describe the request.
 *
 * Every wait is finite and every schedule is injectable, so the tests pin the
 * backoff arithmetic against a fake clock instead of sleeping through it.
 */

/** Retryable failures that carry an HTTP status expose it (the Browserbase
 * SDK's `APIError`, and this module's own download-fetch errors). */
interface StatusCarryingError {
  status?: unknown;
  headers?: unknown;
}

/** How long to wait before attempt N (0-based), before `Retry-After`. */
const BASE_BACKOFF_MS = 500;
/** Cap on one wait, so a large `Retry-After` cannot park a batch for minutes. */
const MAX_BACKOFF_MS = 8_000;
/** Total attempts including the first. Three retries is enough to ride out a
 * concurrency spike and short enough that a genuinely exhausted plan fails
 * while the operator is still watching. */
const DEFAULT_MAX_ATTEMPTS = 4;

export interface BrowserbaseRetryOptions {
  /** Total attempts including the first; defaults to 4. */
  maxAttempts?: number;
  /** Test seam for the wait between attempts. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Receives one line per retry, for operator-visible progress. Never
   * receives a connection URL or an API key. */
  onRetry?: (message: string) => void;
}

/**
 * HTTP status this error reports, or undefined for a transport-level failure.
 *
 * Duck-typed rather than checked against the SDK's `APIError` class: the same
 * helper covers the SDK's errors and the plain-`fetch` download calls, and an
 * `instanceof` against a vendor class would also make every test that wants
 * to simulate a 429 depend on constructing one.
 */
export function browserbaseErrorStatus(error: unknown): number | undefined {
  const status = (error as StatusCarryingError | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** `Retry-After` in milliseconds when the response carried one, honoring both
 * the delay-seconds and HTTP-date forms. */
export function retryAfterMs(error: unknown, nowMs: number): number | undefined {
  const headers = (error as StatusCarryingError | null)?.headers;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : typeof headers === 'object' && headers !== null
        ? ((headers as Record<string, unknown>)['retry-after'] as string | undefined)
        : undefined;
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** Whether waiting could plausibly change this failure's outcome. */
export function isRetryableBrowserbaseError(error: unknown): boolean {
  const status = browserbaseErrorStatus(error);
  // No status at all: a socket reset, a DNS blip, an aborted fetch. Worth one
  // more try — the alternative is a batch that dies on a hiccup.
  if (status === undefined) return true;
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/**
 * Run `operation`, retrying transient Browserbase failures with bounded
 * exponential backoff.
 *
 * @param label - what is being attempted, for the retry message ('create
 *   session', 'list downloads'); must not contain a URL or a key
 * @param operation - receives the 1-based attempt number
 * @returns the operation's value
 * @throws the LAST failure once attempts are exhausted, or the first
 *   non-retryable failure immediately — an unretryable 401 must surface as
 *   itself, not as "gave up after 4 attempts"
 */
export async function withBrowserbaseRetry<T>(
  label: string,
  operation: (attempt: number) => Promise<T>,
  options: BrowserbaseRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableBrowserbaseError(error)) throw error;

      const requested = retryAfterMs(error, Date.now());
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      const wait = Math.min(MAX_BACKOFF_MS, Math.max(backoff, requested ?? 0));
      const status = browserbaseErrorStatus(error);
      options.onRetry?.(
        `browserbase ${label}: ${status ?? 'connection'} failure, retrying in ${wait}ms ` +
          `(attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(wait);
    }
  }
}
