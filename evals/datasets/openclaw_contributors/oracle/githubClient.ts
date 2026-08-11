/**
 * Typed client for the GitHub data behind the contributors task: the
 * repository's top contributors by commit count, with each one's public
 * profile name where they have set one. Parsing is split from fetching so
 * the parse logic can be unit-tested against canned JSON without any
 * network access — only `fetchOpenClawContributors` at the bottom touches
 * the network (through the shared token-aware `githubGetJson`), and the
 * automated suite never calls it.
 *
 * LinkedIn URLs are deliberately absent here: GitHub does not know them,
 * and LinkedIn offers no oracle-usable lookup — the grader can check that
 * column's *shape* only, with correctness left to the human overlay.
 */
import { githubGetJson } from '../../../oracles/githubApi.js';

/** Owner of the target repository. */
export const REPO_OWNER = 'openclaw';

/** Name of the target repository. */
export const REPO_NAME = 'openclaw';

/** How many rows the task's CSV must have. */
export const REQUIRED_ROW_COUNT = 30;

/** How many top contributors the oracle keeps. Larger than the task's 30 so
 *  ranking-edge disagreements (e.g. an agent excluding a bot account, or
 *  commit-count ties ordered differently on the website) don't fail rows
 *  that are honestly top-30-ish. */
export const CONTRIBUTOR_WINDOW_SIZE = 40;

/** How many of the CSV's 30 handles must fall inside the oracle window —
 *  tolerance for the ranking-edge disagreements above. */
export const MIN_MATCHING_HANDLES = 25;

/** One contributor, as the oracle reports it. */
export interface Contributor {
  /** The contributor's GitHub login. */
  login: string;
  /** Commit count that produced the ranking. */
  contributions: number;
  /** The profile's public display name: a string when set, null when the
   *  profile has none, undefined when the oracle did not look it up. */
  name?: string | null;
}

/** Ground truth for the contributors task. */
export interface OpenClawContributorsOracle {
  /** Top contributors, most contributions first, up to
   *  CONTRIBUTOR_WINDOW_SIZE, each with its profile name looked up. */
  contributors: Contributor[];
}

/**
 * Parse a `GET /repos/{owner}/{repo}/contributors` response.
 *
 * @param json - the parsed JSON body of the contributors response
 * @returns contributors sorted by contribution count descending, at most
 *   CONTRIBUTOR_WINDOW_SIZE of them
 * @throws if `json` is not an array or an entry lacks a string `login` or
 *   numeric `contributions`
 */
export function parseContributorsResponse(json: unknown): Contributor[] {
  if (!Array.isArray(json)) {
    throw new Error('contributors response must be an array');
  }
  const contributors = json.map((item, i) => {
    const obj = item as { login?: unknown; contributions?: unknown };
    if (typeof obj.login !== 'string') throw new Error(`contributors[${i}]: missing string "login"`);
    if (typeof obj.contributions !== 'number') {
      throw new Error(`contributors[${i}]: missing numeric "contributions"`);
    }
    return { login: obj.login, contributions: obj.contributions };
  });
  return contributors
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, CONTRIBUTOR_WINDOW_SIZE);
}

/**
 * Extract the public profile name from a `GET /users/{login}` response.
 *
 * @param json - the parsed JSON body of the user response
 * @returns the trimmed `name`, or null when the profile has none (absent,
 *   null, or blank)
 */
export function parseUserName(json: unknown): string | null {
  const name = (json as { name?: unknown } | null)?.name;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return name.trim();
}

/**
 * Fetch the contributors oracle from the live GitHub REST API: one
 * contributors listing, then one profile lookup per contributor for the
 * public name (CONTRIBUTOR_WINDOW_SIZE + 1 requests total). Not called
 * anywhere in the automated test suite.
 *
 * @returns the oracle window, most contributions first, names looked up
 * @throws if the API is unreachable, rate-limits, or returns a shape the
 *   parsers above cannot parse
 */
export async function fetchOpenClawContributors(): Promise<OpenClawContributorsOracle> {
  const list = await githubGetJson(
    `/repos/${REPO_OWNER}/${REPO_NAME}/contributors?per_page=${CONTRIBUTOR_WINDOW_SIZE}`,
  );
  const contributors = await Promise.all(
    parseContributorsResponse(list).map(async (c): Promise<Contributor> => {
      const user = await githubGetJson(`/users/${c.login}`);
      return { ...c, name: parseUserName(user) };
    }),
  );
  return { contributors };
}
