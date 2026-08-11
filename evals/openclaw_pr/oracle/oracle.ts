import { fetchOpenClawPullRequests, type OpenClawPrOracle } from './githubClient.js';

/**
 * Fetch the OpenClaw PR task's oracle data. Thin re-export of
 * `fetchOpenClawPullRequests` under the name `loadEvalTask`
 * (evals/loadTask.ts) requires; the live-fetch logic itself lives in
 * `githubClient.ts`.
 *
 * @returns recent OpenClaw pull requests, freshly fetched
 */
export async function fetchOracle(): Promise<OpenClawPrOracle> {
  return { recentPrs: await fetchOpenClawPullRequests() };
}
