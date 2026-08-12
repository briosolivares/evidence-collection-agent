import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest, ManifestEntry } from '../../../../src/run/artifacts.js';
import { readManifest, requestedOutputs, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { CompanyFreshnessOracle, CompanyFreshnessTarget } from '../oracle/companyContentClient.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COUNT_ASSERTION_NAME = 'at least six valid manifested PNG screenshots exist';
const HOMEPAGE_ASSERTION_NAME = 'each company has a valid screenshot of its official homepage';
const CONTENT_ASSERTION_NAME = 'each company has a valid screenshot from its live latest-content window';
const PAIR_ASSERTION_NAME = 'homepage and content evidence are distinct for all three companies';

interface Screenshot {
  entry: ManifestEntry;
  url: URL;
}

export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const screenshots = validScreenshots(runDirPath, manifest);
  const homeMatches = new Map<string, Screenshot>();
  const contentMatches = new Map<string, Screenshot>();
  for (const company of oracle.companies) {
    const home = screenshots.find((shot) => matchesHomepage(shot.url, company));
    const content = screenshots.find((shot) => matchesCandidate(shot.url, company));
    if (home) homeMatches.set(company.name, home);
    if (content) contentMatches.set(company.name, content);
  }

  const missingHomes = oracle.companies.filter((company) => !homeMatches.has(company.name)).map((company) => company.name);
  const missingContent = oracle.companies.filter((company) => !contentMatches.has(company.name)).map((company) => company.name);
  const reused = oracle.companies.filter((company) =>
    homeMatches.get(company.name)?.entry.filename === contentMatches.get(company.name)?.entry.filename,
  ).map((company) => company.name);
  return [
    {
      name: COUNT_ASSERTION_NAME,
      passed: screenshots.length >= 6,
      detail: `${screenshots.length} valid PNG(s) with source URL provenance`,
    },
    {
      name: HOMEPAGE_ASSERTION_NAME,
      passed: missingHomes.length === 0,
      detail: missingHomes.length ? `missing: ${missingHomes.join(', ')}` : [...homeMatches].map(([name, shot]) => `${name}: ${shot.entry.filename}`).join('; '),
    },
    {
      name: CONTENT_ASSERTION_NAME,
      passed: missingContent.length === 0,
      detail: missingContent.length
        ? `no provenance URL in the newest ${maxWindow(oracle)} official item(s) for: ${missingContent.join(', ')}`
        : `${[...contentMatches].map(([name, shot]) => `${name}: ${shot.url.href}`).join('; ')} (pixel contents are human-reviewed)`,
    },
    {
      name: PAIR_ASSERTION_NAME,
      passed: homeMatches.size === 3 && contentMatches.size === 3 && reused.length === 0,
      detail: reused.length ? `same artifact used for homepage and content: ${reused.join(', ')}` : `${homeMatches.size} homepage/content pair(s) are distinct`,
    },
    verifyManifestHashes(runDirPath, manifest),
  ];
};

function validScreenshots(runDirPath: string, manifest: Manifest): Screenshot[] {
  return requestedOutputs(manifest).flatMap((entry): Screenshot[] => {
    if (!entry.filename.toLowerCase().endsWith('.png') || !entry.sourceUrl) return [];
    const path = join(runDirPath, entry.filename);
    if (!existsSync(path) || !readFileSync(path).subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return [];
    try {
      const url = new URL(entry.sourceUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' ? [{ entry, url }] : [];
    } catch {
      return [];
    }
  });
}

function matchesHomepage(url: URL, company: CompanyFreshnessTarget): boolean {
  if (!company.homepageHosts.includes(url.hostname.toLowerCase())) return false;
  return /^\/(?:[a-z]{2}(?:-[a-z]{2})?)?\/?$/i.test(url.pathname);
}

function matchesCandidate(url: URL, company: CompanyFreshnessTarget): boolean {
  if (!company.homepageHosts.includes(url.hostname.toLowerCase())) return false;
  const actualPath = contentPath(url.pathname);
  return company.contentCandidates.some((candidate) => {
    try {
      const expected = new URL(candidate.url);
      return company.homepageHosts.includes(expected.hostname.toLowerCase()) && contentPath(expected.pathname) === actualPath;
    } catch {
      return false;
    }
  });
}

/** Locale prefixes are deployment/browser routing, not distinct content. */
function contentPath(pathname: string): string {
  return pathname.toLowerCase().replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/blog\/)/, '').replace(/\/$/, '');
}

function maxWindow(oracle: CompanyFreshnessOracle): number {
  return Math.max(...oracle.companies.map((company) => company.contentCandidates.length));
}

function asOracle(data: unknown): CompanyFreshnessOracle {
  const companies = (data as { companies?: unknown } | null)?.companies;
  const valid = Array.isArray(companies) && companies.length === 3 && companies.every((company) =>
    typeof company === 'object' && company !== null && typeof (company as { name?: unknown }).name === 'string' &&
    Array.isArray((company as { homepageHosts?: unknown }).homepageHosts) &&
    (company as { homepageHosts: unknown[] }).homepageHosts.every((host) => typeof host === 'string') &&
    Array.isArray((company as { contentCandidates?: unknown }).contentCandidates) &&
    (company as { contentCandidates: unknown[] }).contentCandidates.length > 0 &&
    (company as { contentCandidates: unknown[] }).contentCandidates.every((candidate) =>
      typeof candidate === 'object' && candidate !== null && typeof (candidate as { url?: unknown }).url === 'string' &&
      typeof (candidate as { publishedAt?: unknown }).publishedAt === 'string'));
  if (!valid) throw new Error('company_freshness grader was handed malformed oracle data');
  return data as CompanyFreshnessOracle;
}
