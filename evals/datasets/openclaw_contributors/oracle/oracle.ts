import { fetchOpenClawContributors, type OpenClawContributorsOracle } from './githubClient.js';

/**
 * Fetch the contributors task's oracle data. Thin re-export of
 * `fetchOpenClawContributors` under the name `loadEvalTask`
 * (evals/runners/loadTask.ts) requires; the live-fetch logic itself lives
 * in `githubClient.ts`.
 *
 * @returns the top-contributors window, freshly fetched
 */
export async function fetchOracle(): Promise<OpenClawContributorsOracle> {
  return fetchOpenClawContributors();
}
