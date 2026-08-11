/**
 * Typed client for the GitHub data behind the merged-PRs task: recently
 * merged pull requests with who authored, reviewed, and merged each one.
 * Parsing is split from fetching so the parse logic can be unit-tested
 * against canned JSON without any network access — only
 * `fetchOpenClawMergedPrs` at the bottom touches the network (through the
 * shared token-aware `githubGetJson`), and the automated suite never calls
 * it.
 */
import { githubGetJson } from '../../../oracles/githubApi.js';

/** Owner of the target repository. */
export const REPO_OWNER = 'openclaw';

/** Name of the target repository. */
export const REPO_NAME = 'openclaw';

/** How many rows the task's CSV must have. */
export const REQUIRED_ROW_COUNT = 10;

/** How many recently merged PRs the oracle keeps as its membership window.
 *  Sized well beyond REQUIRED_ROW_COUNT so PRs that merge between the run
 *  and grading time cannot push a correctly-reported PR out of the window. */
export const MERGED_WINDOW_SIZE = 30;

/** How many of the window's newest PRs get the two extra per-PR API calls
 *  (detail + reviews) that make committer/reviewer/merger verifiable. A
 *  correct run's 10 PRs sit at the top of the window, so detailing the top
 *  15 covers them with churn headroom without detailing all 30. */
export const DETAILED_COUNT = 15;

/** One merged pull request, as the oracle reports it. */
export interface MergedPr {
  /** The PR's number within its repository. */
  number: number;
  /** The PR's title, verbatim. */
  title: string;
  /** The PR's web URL. */
  url: string;
  /** ISO 8601 timestamp of when the PR was merged. */
  mergedAt: string;
  /** Login of the user who opened the PR (the task's "committer"). */
  author: string;
  /** Login of the user who merged the PR; present only for the detailed
   *  (newest DETAILED_COUNT) subset of the window. */
  mergedBy?: string;
  /** Distinct logins that submitted a review, the author excluded; present
   *  only for the detailed subset. */
  reviewers?: string[];
}

/** Ground truth for the merged-PRs task. */
export interface OpenClawMergedPrsOracle {
  /** Recently merged PRs, most recently merged first, up to
   *  MERGED_WINDOW_SIZE; the newest DETAILED_COUNT carry mergedBy and
   *  reviewers. */
  mergedWindow: MergedPr[];
}

/**
 * Parse a `GET /repos/{owner}/{repo}/pulls?state=closed` response into the
 * merged PRs it contains, sorted most-recently-merged first.
 *
 * @param json - the parsed JSON body of the pulls-list response
 * @returns merged PRs (entries with a null `merged_at` are unmerged closes
 *   and are dropped), sorted by `mergedAt` descending, at most
 *   MERGED_WINDOW_SIZE of them
 * @throws if `json` is not an array, or a merged entry lacks a numeric
 *   `number`, string `title`, string `html_url`, parseable `merged_at`, or
 *   `user.login`
 */
export function parseMergedPullsResponse(json: unknown): MergedPr[] {
  if (!Array.isArray(json)) {
    throw new Error('pulls response must be an array');
  }
  const merged = json
    .filter((item) => (item as { merged_at?: unknown } | null)?.merged_at != null)
    .map((item, i) => parseOneMergedPull(item, i));
  return merged
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, MERGED_WINDOW_SIZE);
}

function parseOneMergedPull(item: unknown, index: number): MergedPr {
  const obj = item as {
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    merged_at?: unknown;
    user?: { login?: unknown } | null;
  };
  if (typeof obj.number !== 'number') throw new Error(`pulls[${index}]: missing numeric "number"`);
  if (typeof obj.title !== 'string') throw new Error(`pulls[${index}]: missing string "title"`);
  if (typeof obj.html_url !== 'string') throw new Error(`pulls[${index}]: missing string "html_url"`);
  if (typeof obj.merged_at !== 'string' || Number.isNaN(Date.parse(obj.merged_at))) {
    throw new Error(`pulls[${index}]: missing or unparseable "merged_at"`);
  }
  if (typeof obj.user?.login !== 'string') {
    throw new Error(`pulls[${index}]: missing "user.login"`);
  }
  return {
    number: obj.number,
    title: obj.title,
    url: obj.html_url,
    mergedAt: obj.merged_at,
    author: obj.user.login,
  };
}

/**
 * Extract the merging user's login from a `GET /repos/{o}/{r}/pulls/{n}`
 * detail response.
 *
 * @param json - the parsed JSON body of the PR detail response
 * @returns the `merged_by.login`, or undefined when the response has none
 *   (defensive: merged PRs normally always carry it)
 */
export function parseMergedBy(json: unknown): string | undefined {
  const login = (json as { merged_by?: { login?: unknown } | null } | null)?.merged_by?.login;
  return typeof login === 'string' ? login : undefined;
}

/**
 * Extract distinct reviewer logins from a `GET .../pulls/{n}/reviews`
 * response.
 *
 * @param json - the parsed JSON body of the reviews-list response
 * @param authorLogin - the PR author's login; the author's own review
 *   comments are not reviews of the PR and are excluded
 * @returns distinct logins that submitted a review, in first-appearance
 *   order; entries without a user are skipped
 * @throws if `json` is not an array
 */
export function parseReviewers(json: unknown, authorLogin: string): string[] {
  if (!Array.isArray(json)) {
    throw new Error('reviews response must be an array');
  }
  const logins: string[] = [];
  for (const item of json) {
    const login = (item as { user?: { login?: unknown } | null } | null)?.user?.login;
    if (typeof login === 'string' && login !== authorLogin && !logins.includes(login)) {
      logins.push(login);
    }
  }
  return logins;
}

/**
 * Fetch the merged-PRs oracle from the live GitHub REST API: one closed-PRs
 * listing (sorted by update recency — the closest proxy the REST API offers
 * to "recently merged"; a merge updates the PR, so a 100-entry page reliably
 * contains the newest merges), then detail + reviews calls for the newest
 * DETAILED_COUNT merged PRs (2 × DETAILED_COUNT + 1 requests total). Not
 * called anywhere in the automated test suite.
 *
 * @returns the oracle window, newest merge first
 * @throws if the API is unreachable, rate-limits, or returns a shape the
 *   parsers above cannot parse
 */
export async function fetchOpenClawMergedPrs(): Promise<OpenClawMergedPrsOracle> {
  const list = await githubGetJson(
    `/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
  );
  const window = parseMergedPullsResponse(list);

  const detailed = await Promise.all(
    window.slice(0, DETAILED_COUNT).map(async (pr): Promise<MergedPr> => {
      const [detail, reviews] = await Promise.all([
        githubGetJson(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${pr.number}`),
        githubGetJson(`/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${pr.number}/reviews?per_page=100`),
      ]);
      return {
        ...pr,
        mergedBy: parseMergedBy(detail),
        reviewers: parseReviewers(reviews, pr.author),
      };
    }),
  );

  return { mergedWindow: [...detailed, ...window.slice(DETAILED_COUNT)] };
}
