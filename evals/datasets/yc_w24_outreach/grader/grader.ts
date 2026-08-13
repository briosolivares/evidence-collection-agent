import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '../../../grading/csv.js';
import { exactColumnsAssertion, exactColumnsAssertionName } from '../../../grading/csvAssertions.js';
import { findArtifactByExtension, readManifest, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { YcAiCompany, YcW24AiOracle } from '../oracle/ycClient.js';

const REQUIRED_COLUMNS = ['founder_name', 'linkedin_url', 'cold_outreach_email'] as const;
const COLUMN_ASSERTION_NAME = exactColumnsAssertionName(REQUIRED_COLUMNS);
const ROW_ASSERTION_NAME = 'CSV has a plausible number of distinct, non-empty founder rows';
const FOUNDER_ASSERTION_NAME = 'every founder belongs to an oracle-listed YC W24 AI company';
const COMPANY_ASSERTION_NAME = 'rows represent exactly five companies and include every oracle-listed founder for each';
const LINKEDIN_ASSERTION_NAME = 'every LinkedIn URL is a distinct plausible personal profile for its founder';
const EMAIL_ASSERTION_NAME = 'every outreach email is founder/company personalized and asks for a 15-minute call';

interface OutreachRow {
  rowNumber: number;
  founderName: string;
  linkedinUrl: string;
  email: string;
}

interface MatchedRow {
  row: OutreachRow;
  company: YcAiCompany;
  canonicalFounder: string;
}

export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const csvEntry = findArtifactByExtension(manifest, '.csv');
  const assertions: AssertionResult[] = [{
    name: 'CSV artifact exists',
    passed: csvEntry !== undefined,
    detail: csvEntry ? `found ${csvEntry.filename}` : 'no .csv artifact found in the manifest',
  }];
  if (!csvEntry) {
    return [...assertions, ...failedContent('no CSV artifact to check'), verifyManifestHashes(runDirPath, manifest)];
  }

  let header: string[];
  let rawRows: string[][];
  try {
    ({ header, rows: rawRows } = parseCsv(readFileSync(join(runDirPath, csvEntry.filename), 'utf8')));
  } catch (error) {
    const detail = `${csvEntry.filename} could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    return [...assertions, ...failedContent(detail), verifyManifestHashes(runDirPath, manifest)];
  }
  const rows = resolveRows(header, rawRows);
  const matched = matchRows(rows, oracle);
  assertions.push(exactColumnsAssertion(header, REQUIRED_COLUMNS));
  assertions.push(rowAssertion(rows));
  assertions.push(founderAssertion(rows, matched));
  assertions.push(companyAssertion(matched));
  assertions.push(linkedinAssertion(rows));
  assertions.push(emailAssertion(rows, matched));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

function resolveRows(header: string[], rawRows: string[][]): OutreachRow[] {
  const index = (name: string): number => header.findIndex((cell) => cell.trim().toLowerCase() === name);
  const founderIndex = index('founder_name');
  const linkedinIndex = index('linkedin_url');
  const emailIndex = index('cold_outreach_email');
  const cell = (row: string[], i: number): string => i < 0 ? '' : (row[i] ?? '').trim();
  return rawRows.map((row, i) => ({
    rowNumber: i + 1,
    founderName: cell(row, founderIndex),
    linkedinUrl: cell(row, linkedinIndex),
    email: cell(row, emailIndex),
  }));
}

function matchRows(rows: OutreachRow[], oracle: YcW24AiOracle): MatchedRow[] {
  const byFounder = new Map<string, { company: YcAiCompany; canonicalFounder: string }>();
  for (const company of oracle.companies) {
    for (const founder of company.founders) byFounder.set(normalize(founder), { company, canonicalFounder: founder });
  }
  return rows.flatMap((row) => {
    const match = byFounder.get(normalize(row.founderName));
    return match ? [{ row, ...match }] : [];
  });
}

function rowAssertion(rows: OutreachRow[]): AssertionResult {
  const normalized = rows.filter((row) => row.founderName).map((row) => normalize(row.founderName));
  const empty = rows.filter((row) => !row.founderName || !row.linkedinUrl || !row.email).map((row) => row.rowNumber);
  const duplicateCount = normalized.length - new Set(normalized).size;
  const problems = [
    rows.length < 5 || rows.length > 40 ? `found ${rows.length} row(s), expected 5–40` : '',
    empty.length ? `empty required cell(s) in row(s) ${empty.join(', ')}` : '',
    duplicateCount ? `${duplicateCount} duplicate founder row(s)` : '',
  ].filter(Boolean);
  return {
    name: ROW_ASSERTION_NAME,
    passed: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${rows.length} distinct complete row(s)`,
  };
}

function founderAssertion(rows: OutreachRow[], matched: MatchedRow[]): AssertionResult {
  const matchedRows = new Set(matched.map(({ row }) => row.rowNumber));
  const unknown = rows.filter((row) => !matchedRows.has(row.rowNumber)).map((row) => `row ${row.rowNumber}: ${row.founderName || '(empty)'}`);
  return {
    name: FOUNDER_ASSERTION_NAME,
    passed: rows.length > 0 && unknown.length === 0,
    detail: unknown.length ? `not found in live YC W24 AI founder oracle: ${unknown.join('; ')}` : `${matched.length} founder(s) matched`,
  };
}

function companyAssertion(matched: MatchedRow[]): AssertionResult {
  const companies = new Map<string, YcAiCompany>();
  for (const item of matched) companies.set(item.company.slug, item.company);
  const missing: string[] = [];
  for (const company of companies.values()) {
    const present = new Set(matched.filter((item) => item.company.slug === company.slug).map((item) => normalize(item.canonicalFounder)));
    for (const founder of company.founders) if (!present.has(normalize(founder))) missing.push(`${company.name}: ${founder}`);
  }
  const passed = companies.size === 5 && missing.length === 0;
  return {
    name: COMPANY_ASSERTION_NAME,
    passed,
    detail: `${companies.size} distinct compan${companies.size === 1 ? 'y' : 'ies'}` +
      (missing.length ? `; missing founder row(s): ${missing.join(', ')}` : '; all public founders represented'),
  };
}

function linkedinAssertion(rows: OutreachRow[]): AssertionResult {
  const urls: string[] = [];
  const bad: string[] = [];
  for (const row of rows) {
    try {
      const url = new URL(row.linkedinUrl);
      const host = url.hostname.toLowerCase();
      const slug = /^\/in\/([^/?#]+)/i.exec(url.pathname)?.[1]?.toLowerCase().replace(/[^a-z0-9]/g, '');
      const nameTokens = normalize(row.founderName).split(' ').filter((token) => token.length >= 3);
      // Real handles are often truncated or initials-style ("binw" for
      // Bing Wu), so a ≥3-char prefix of a name token counts as a match;
      // profile ownership stays human-reviewed.
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
          (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) || !slug ||
          !nameTokens.some((token) => slug.includes(token.slice(0, 3)))) {
        bad.push(`row ${row.rowNumber}: ${row.linkedinUrl}`);
      } else {
        urls.push(url.href.toLowerCase().replace(/\/$/, ''));
      }
    } catch {
      bad.push(`row ${row.rowNumber}: ${row.linkedinUrl}`);
    }
  }
  const duplicateCount = urls.length - new Set(urls).size;
  if (duplicateCount) bad.push(`${duplicateCount} duplicate profile URL(s)`);
  return {
    name: LINKEDIN_ASSERTION_NAME,
    passed: rows.length > 0 && bad.length === 0,
    detail: bad.length ? bad.join('; ') : `${urls.length} personal linkedin.com/in URLs (profile ownership is human-reviewed)`,
  };
}

function emailAssertion(rows: OutreachRow[], matched: MatchedRow[]): AssertionResult {
  const matchByRow = new Map(matched.map((item) => [item.row.rowNumber, item]));
  const bad: string[] = [];
  for (const row of rows) {
    const match = matchByRow.get(row.rowNumber);
    if (!match) {
      bad.push(`row ${row.rowNumber}: founder cannot be personalized without an oracle match`);
      continue;
    }
    const email = normalize(row.email);
    const firstName = normalize(match.canonicalFounder).split(' ')[0]!;
    const companyName = normalize(match.company.name);
    const asksFor15Minutes = /\b15\s*(?:min|mins|minute|minutes)\b/.test(email) && /\b(call|chat|conversation|meeting)\b/.test(email);
    const personalizedTokens = personalizationTokens(match.company);
    const hasSpecificDetail = personalizedTokens.some((token) => email.includes(token));
    const problems = [
      !email.includes(firstName) ? 'missing founder first name' : '',
      !email.includes(companyName) ? 'missing company name' : '',
      !asksFor15Minutes ? 'no 15-minute call ask' : '',
      !hasSpecificDetail ? 'no company-specific product/detail term' : '',
      row.email.trim().length < 120 ? 'under 120 characters' : '',
    ].filter(Boolean);
    if (problems.length) bad.push(`row ${row.rowNumber}: ${problems.join(', ')}`);
  }
  const normalizedEmails = rows.map((row) => normalize(row.email));
  if (new Set(normalizedEmails).size !== normalizedEmails.length) bad.push('duplicate outreach email(s)');
  return {
    name: EMAIL_ASSERTION_NAME,
    passed: rows.length > 0 && bad.length === 0,
    detail: bad.length ? bad.join('; ') : `${rows.length} personalized call requests passed structural checks (prose quality is human-reviewed)`,
  };
}

function personalizationTokens(company: YcAiCompany): string[] {
  const stop = new Set(['about', 'after', 'again', 'against', 'artificial', 'build', 'building', 'company', 'could',
    'focus', 'focused', 'founder', 'intelligence', 'platform', 'product', 'their', 'there', 'these', 'those', 'using',
    'where', 'which', 'while', 'with', 'would', ...normalize(company.name).split(' ')]);
  return normalize([company.oneLiner, company.longDescription, ...company.tags].join(' '))
    .split(' ').filter((token) => token.length >= 5 && !stop.has(token));
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function failedContent(detail: string): AssertionResult[] {
  return [COLUMN_ASSERTION_NAME, ROW_ASSERTION_NAME, FOUNDER_ASSERTION_NAME, COMPANY_ASSERTION_NAME, LINKEDIN_ASSERTION_NAME, EMAIL_ASSERTION_NAME]
    .map((name) => ({ name, passed: false, detail }));
}

function asOracle(data: unknown): YcW24AiOracle {
  const companies = (data as { companies?: unknown } | null)?.companies;
  const valid = Array.isArray(companies) && companies.length >= 5 && companies.every((company) =>
    typeof company === 'object' && company !== null && typeof (company as { name?: unknown }).name === 'string' &&
    typeof (company as { slug?: unknown }).slug === 'string' && Array.isArray((company as { founders?: unknown }).founders) &&
    ((company as { founders: unknown[] }).founders).length > 0 &&
    (company as { founders: unknown[] }).founders.every((founder) => typeof founder === 'string'));
  if (!valid) throw new Error('yc_w24_outreach grader was handed malformed oracle data');
  return data as YcW24AiOracle;
}
