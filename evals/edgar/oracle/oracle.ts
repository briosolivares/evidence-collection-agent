import { fetchEdgarOracle, type EdgarOracle } from './edgarClient.js';

/**
 * Fetch the EDGAR task's oracle data. Thin re-export of `fetchEdgarOracle`
 * under the name `loadEvalTask` (evals/loadTask.ts) requires; the
 * live-fetch logic itself lives in `edgarClient.ts`.
 *
 * @returns the target filing plus its primary document's bytes and hash,
 *   freshly fetched from SEC EDGAR
 */
export async function fetchOracle(): Promise<EdgarOracle> {
  return fetchEdgarOracle();
}
