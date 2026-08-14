/**
 * Shared GitHub REST API access for oracle clients: one place for the base
 * URL, request headers, and the optional GITHUB_TOKEN. Unauthenticated
 * GitHub API calls are limited to 60/hour per IP — too few for a k=3 eval
 * whose oracles make dozens of calls per trial — while a token raises the
 * limit to 5,000/hour. The token is read from the environment at call time
 * (`npm run evals` loads `.env`; a bare `tsx evals/runners/cli.ts` needs
 * `--env-file-if-exists=.env` passed by hand) and is never logged.
 *
 * Missing it is a failure worth announcing, because of *where* it surfaces:
 * the agent run succeeds and the grader dies afterwards on HTTP 403, which
 * reads as an agent regression. On 2026-08-14 that cost a k=3 batch — three
 * correct runs reported as 33.3% accuracy, 1/3 completion — so the first
 * unauthenticated request says so out loud.
 */

import { fetchWithRetry } from './fetchWithRetry.js';

/** Base URL of the GitHub REST API. */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Whether the missing-token warning has already been emitted. A batch makes
 * hundreds of oracle calls; the advice is identical every time, so it is
 * worth saying once and never again.
 */
let warnedAboutMissingToken = false;

/**
 * Build the request headers for a GitHub API call: JSON accept, a stable
 * User-Agent, and — when the GITHUB_TOKEN environment variable is set and
 * non-blank — a bearer Authorization header.
 *
 * When the token is absent the call still proceeds, unauthenticated, and the
 * first such call warns. Warning here rather than at startup keeps a batch of
 * non-GitHub tasks quiet: only an eval that actually reaches a GitHub oracle
 * is at risk of exhausting the 60/hour limit.
 *
 * @param warn - sink for the one-time missing-token warning
 * @returns the headers for one GitHub API request
 */
export function githubHeaders(
  warn: (message: string) => void = console.warn,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'evidence-collection-agent-eval',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token !== '') {
    headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  if (!warnedAboutMissingToken) {
    warnedAboutMissingToken = true;
    warn(
      'warning: GITHUB_TOKEN is not set — GitHub oracles will run unauthenticated at ' +
        '60 requests/hour, too few to grade a k=3 batch. Expect trials to finish and ' +
        'then fail grading with HTTP 403. Set it in .env (loaded by `npm run evals`) ' +
        'or pass --env-file-if-exists=.env when invoking the runner directly.',
    );
  }
  return headers;
}

/**
 * GET a GitHub API path and return its parsed JSON body. The one live-HTTP
 * seam the GitHub-based oracles share; the automated test suite never calls
 * it.
 *
 * @param path - API path starting with `/` (e.g. `/repos/o/r/pulls?...`)
 * @returns the response body, JSON-parsed
 * @throws on any non-2xx response that survives fetchWithRetry's transient
 *   retries (network errors and 408/429/5xx get up to 4 attempts), naming
 *   the path and status; when the failure is rate-limit exhaustion, the
 *   message says how to raise the limit (set GITHUB_TOKEN)
 */
export async function githubGetJson(path: string): Promise<unknown> {
  const response = await fetchWithRetry(`${GITHUB_API_BASE}${path}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    const rateLimited =
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(
      `GitHub API GET ${path} failed with HTTP ${response.status}` +
        (rateLimited
          ? ' (rate limit exhausted — set GITHUB_TOKEN in .env to raise it to 5,000/hr)'
          : ''),
    );
  }
  return response.json();
}
