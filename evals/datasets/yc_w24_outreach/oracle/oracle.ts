import { fetchYcW24AiCompanies, type YcW24AiOracle } from './ycClient.js';

export async function fetchOracle(): Promise<YcW24AiOracle> {
  return fetchYcW24AiCompanies();
}
