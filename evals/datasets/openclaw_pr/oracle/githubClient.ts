/**
 * Typed client for the GitHub REST API's pull-request listing. Parsing is
 * split from fetching so the parse logic (and the churn-tolerant window
 * calculation below) can be unit-tested against canned JSON without any
 * network access — only `fetchOpenClawPullRequests` at the bottom of this
 * file touches the network, and the automated suite never calls it.
 */

import { githubGetJson } from '../../../oracles/githubApi.js';

/** Owner of the target repository. */
export const REPO_OWNER = 'openclaw';

/** Name of the target repository. */
export const REPO_NAME = 'openclaw';

/** How many of the most recently created PRs to fetch — enough history to
 *  cover "what was most recent" at any point during a typical run window,
 *  even across a PR or two of churn between run and grading. */
export const PR_HISTORY_LIMIT = 10;

/** One GitHub pull request, as the oracle reports it. */
export interface GithubPullRequest {
  /** The PR's number within its repository. */
  number: number;
  /** The PR's title, verbatim. */
  title: string;
  /** The PR's web URL. */
  url: string;
  /** ISO 8601 timestamp of when the PR was created. */
  createdAt: string;
}

/** Ground truth for the OpenClaw PR task: enough recent PR history to judge
 *  churn-tolerant "most recent at the time" claims. */
export interface OpenClawPrOracle {
  /** Recent PRs on the target repository, most-recently-created first. */
  recentPrs: GithubPullRequest[];
}

/**
 * Parse a `GET /repos/{owner}/{repo}/pulls` response into typed pull
 * requests, sorted most-recently-created first (the API's own ordering is
 * not trusted).
 *
 * @param json - the parsed JSON body of the pulls-list response
 * @returns the pull requests, sorted by `createdAt` descending
 * @throws if `json` is not an array of objects each having a numeric
 *   `number`, string `title`, string `html_url`, and string `created_at`
 */
export function parsePullRequestsResponse(json: unknown): GithubPullRequest[] {
  if (!Array.isArray(json)) {
    throw new Error('pulls response must be an array');
  }
  const prs = json.map((item, i) => parseOnePullRequest(item, i));
  return prs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function parseOnePullRequest(item: unknown, index: number): GithubPullRequest {
  if (typeof item !== 'object' || item === null) {
    throw new Error(`pulls[${index}]: entry is not an object`);
  }
  const obj = item as {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    created_at?: unknown;
  };
  if (typeof obj.number !== 'number') throw new Error(`pulls[${index}]: missing numeric "number"`);
  if (typeof obj.title !== 'string') throw new Error(`pulls[${index}]: missing string "title"`);
  if (typeof obj.html_url !== 'string')
    throw new Error(`pulls[${index}]: missing string "html_url"`);
  if (typeof obj.created_at !== 'string' || Number.isNaN(Date.parse(obj.created_at))) {
    throw new Error(`pulls[${index}]: missing or unparseable "created_at"`);
  }
  return { number: obj.number, title: obj.title, url: obj.html_url, createdAt: obj.created_at };
}

/**
 * Determine which pull requests could correctly have been reported as "the
 * most recent PR" at some point during a run's time window — the design's
 * churn-tolerance rule for this task. The "most recent PR" as observed at
 * an instant is a step function of time: it starts as whichever PR was
 * newest at `startedAt`, then jumps to each subsequent PR the moment that
 * PR is created. This returns every value that step function takes across
 * `[startedAt, finishedAt]`.
 *
 * @param prs - candidate pull requests (any order; need not be sorted)
 * @param startedAt - ISO 8601 timestamp of the run's start (inclusive)
 * @param finishedAt - ISO 8601 timestamp of the run's end (inclusive)
 * @returns the pull requests that were "most recent" at `startedAt`, plus
 *   every pull request created strictly after `startedAt` and at or before
 *   `finishedAt`; a PR created after `finishedAt` could not have been seen
 *   during the run and is never included
 * @throws if `startedAt` or `finishedAt` does not parse as a valid date
 */
export function acceptablePrsInWindow(
  prs: GithubPullRequest[],
  startedAt: string,
  finishedAt: string,
): GithubPullRequest[] {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (Number.isNaN(startMs)) throw new Error(`startedAt does not parse as a date: ${startedAt}`);
  if (Number.isNaN(endMs)) throw new Error(`finishedAt does not parse as a date: ${finishedAt}`);

  const ascending = [...prs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const createdDuringRun = ascending.filter((p) => {
    const t = Date.parse(p.createdAt);
    return t > startMs && t <= endMs;
  });
  const createdAtOrBeforeStart = ascending.filter((p) => Date.parse(p.createdAt) <= startMs);
  const mostRecentAtStart = createdAtOrBeforeStart.at(-1);

  return mostRecentAtStart !== undefined
    ? [mostRecentAtStart, ...createdDuringRun]
    : createdDuringRun;
}

/**
 * Fetch recent pull requests on the OpenClaw repository from the live
 * GitHub REST API. Not called anywhere in the automated test suite — it is
 * the one live-HTTP seam this module exposes, exercised only by
 * `oracle/oracle.ts` at grading time and by demos.
 *
 * @returns up to `PR_HISTORY_LIMIT` of the most recently created pull
 *   requests, sorted most-recent first
 * @throws if the API is unreachable or returns a response
 *   `parsePullRequestsResponse` cannot parse
 */
export async function fetchOpenClawPullRequests(): Promise<GithubPullRequest[]> {
  const path =
    `/repos/${REPO_OWNER}/${REPO_NAME}/pulls` +
    `?state=all&sort=created&direction=desc&per_page=${PR_HISTORY_LIMIT}`;
  return parsePullRequestsResponse(await githubGetJson(path));
}
