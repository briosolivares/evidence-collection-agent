import { fetchCompanyFreshnessOracle, type CompanyFreshnessOracle } from './companyContentClient.js';

export async function fetchOracle(): Promise<CompanyFreshnessOracle> {
  return fetchCompanyFreshnessOracle();
}
