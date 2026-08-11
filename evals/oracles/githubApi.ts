/**
 * Shared GitHub REST API access for oracle clients: one place for the base
 * URL, request headers, and the optional GITHUB_TOKEN. Unauthenticated
 * GitHub API calls are limited to 60/hour per IP — too few for a k=3 eval
 * whose oracles make dozens of calls per trial — while a token raises the
 * limit to 5,000/hour. The token is read from the environment at call time
 * (the eval CLI runs under `--env-file=.env`) and is never logged.
 */

/** Base URL of the GitHub REST API. */
export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Build the request headers for a GitHub API call: JSON accept, a stable
 * User-Agent, and — when the GITHUB_TOKEN environment variable is set and
 * non-blank — a bearer Authorization header.
 *
 * @returns the headers for one GitHub API request
 */
export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'evidence-collection-agent-eval',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token !== '') {
    headers.Authorization = `Bearer ${token}`;
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
 * @throws on any non-2xx response, naming the path and status; when the
 *   failure is rate-limit exhaustion, the message says how to raise the
 *   limit (set GITHUB_TOKEN)
 */
export async function githubGetJson(path: string): Promise<unknown> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, { headers: githubHeaders() });
  if (!response.ok) {
    const rateLimited =
      response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    throw new Error(
      `GitHub API GET ${path} failed with HTTP ${response.status}` +
        (rateLimited
          ? ' (rate limit exhausted — set GITHUB_TOKEN in .env to raise it to 5,000/hr)'
          : ''),
    );
  }
  return response.json();
}
