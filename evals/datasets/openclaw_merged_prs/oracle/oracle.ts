import { fetchOpenClawMergedPrs, type OpenClawMergedPrsOracle } from './githubClient.js';

/**
 * Fetch the merged-PRs task's oracle data. Thin re-export of
 * `fetchOpenClawMergedPrs` under the name `loadEvalTask`
 * (evals/runners/loadTask.ts) requires; the live-fetch logic itself lives
 * in `githubClient.ts`.
 *
 * @returns the recently-merged-PRs window, freshly fetched
 */
export async function fetchOracle(): Promise<OpenClawMergedPrsOracle> {
  return fetchOpenClawMergedPrs();
}
