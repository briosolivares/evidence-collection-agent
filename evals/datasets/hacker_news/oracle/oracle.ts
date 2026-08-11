import { fetchHackerNewsOracle, type HackerNewsOracle } from './hackerNewsClient.js';

/**
 * Fetch the Hacker News task's oracle data. Thin re-export of
 * `fetchHackerNewsOracle` under the name `loadEvalTask` (evals/loadTask.ts)
 * requires; the live-fetch logic itself lives in `hackerNewsClient.ts`.
 *
 * @returns the current top Hacker News stories, freshly fetched
 */
export async function fetchOracle(): Promise<HackerNewsOracle> {
  return fetchHackerNewsOracle();
}
