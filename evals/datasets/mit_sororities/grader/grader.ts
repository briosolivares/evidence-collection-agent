import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '../../../grading/csv.js';
import { exactColumnsAssertion, exactColumnsAssertionName } from '../../../grading/csvAssertions.js';
import { findRequestedOutputByName, readManifest, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { MitSororitiesOracle } from '../oracle/oracle.js';

const CSV_FILENAME = 'sorority_members.csv';
const ANSWER_FILENAME = 'answer.md';
const REQUIRED_COLUMNS = ['name', 'class', 'major', 'affiliation', 'interests', 'other'] as const;
const COLUMN_ASSERTION_NAME = exactColumnsAssertionName(REQUIRED_COLUMNS);
/** Exported so the CSV-only variant can drop exactly this assertion by
 * name instead of restating a string that would silently stop matching. */
export const SHEET_ASSERTION_NAME = 'answer.md contains a plausible Google Sheets URL';
const COHORT_ASSERTION_NAME = 'CSV has plausible rows and every sorority/class cohort is represented';
const IDENTITY_ASSERTION_NAME = 'member names are plausible and unique within each affiliation';
const DETAIL_ASSERTION_NAME = 'major and interests/other fields meet minimum information coverage';

interface MemberRow {
  rowNumber: number;
  name: string;
  classYear: number | undefined;
  major: string;
  affiliation: string | undefined;
  interests: string;
  other: string;
}

export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const csvEntry = findRequestedOutputByName(manifest, CSV_FILENAME);
  const csvExists = csvEntry !== undefined && existsSync(join(runDirPath, csvEntry.filename));
  const assertions: AssertionResult[] = [{
    name: `${CSV_FILENAME} exists with a manifest entry`,
    passed: csvExists,
    detail: csvExists
      ? `${csvEntry!.filename} found and manifested`
      : `${CSV_FILENAME} missing or not published as a requested output`,
  }];
  assertions.push(sheetAssertion(runDirPath, manifest));

  if (!csvExists) {
    return [...assertions, ...failedCsvContent(`${CSV_FILENAME} is unavailable`), verifyManifestHashes(runDirPath, manifest)];
  }

  let header: string[];
  let rawRows: string[][];
  try {
    ({ header, rows: rawRows } = parseCsv(readFileSync(join(runDirPath, csvEntry!.filename), 'utf8')));
  } catch (error) {
    const detail = `${CSV_FILENAME} could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    return [...assertions, ...failedCsvContent(detail), verifyManifestHashes(runDirPath, manifest)];
  }
  const rows = resolveRows(header, rawRows, oracle);
  assertions.push(exactColumnsAssertion(header, REQUIRED_COLUMNS));
  assertions.push(cohortAssertion(rows, oracle));
  assertions.push(identityAssertion(rows));
  assertions.push(detailAssertion(rows, oracle));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

function sheetAssertion(runDirPath: string, manifest: ReturnType<typeof readManifest>): AssertionResult {
  const entry = findRequestedOutputByName(manifest, ANSWER_FILENAME);
  if (!entry || !existsSync(join(runDirPath, entry.filename))) {
    return {
      name: SHEET_ASSERTION_NAME,
      passed: false,
      detail: `${ANSWER_FILENAME} missing or not published as a requested output`,
    };
  }
  const text = readFileSync(join(runDirPath, entry.filename), 'utf8');
  const urls = text.match(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s)>\]}]*/gi) ?? [];
  return {
    name: SHEET_ASSERTION_NAME,
    passed: urls.length > 0,
    detail: urls.length ? `found ${urls[0]}` : 'no docs.google.com/spreadsheets/d/<id> URL found (private sheet contents remain human-reviewed)',
  };
}

function resolveRows(header: string[], rawRows: string[][], oracle: MitSororitiesOracle): MemberRow[] {
  const index = (name: string): number => header.findIndex((cell) => cell.trim().toLowerCase() === name);
  const cell = (row: string[], i: number): string => i < 0 ? '' : (row[i] ?? '').trim();
  const indices = Object.fromEntries(REQUIRED_COLUMNS.map((name) => [name, index(name)])) as Record<typeof REQUIRED_COLUMNS[number], number>;
  return rawRows.map((row, rowIndex) => ({
    rowNumber: rowIndex + 1,
    name: cell(row, indices.name),
    classYear: normalizeClass(cell(row, indices.class), oracle.classes),
    major: cell(row, indices.major),
    affiliation: normalizeAffiliation(cell(row, indices.affiliation), oracle.affiliations),
    interests: cell(row, indices.interests),
    other: cell(row, indices.other),
  }));
}

function cohortAssertion(rows: MemberRow[], oracle: MitSororitiesOracle): AssertionResult {
  const problems: string[] = [];
  if (rows.length < oracle.minRows || rows.length > oracle.maxRows) problems.push(`found ${rows.length} rows, expected ${oracle.minRows}–${oracle.maxRows}`);
  const invalidClass = rows.filter((row) => row.classYear === undefined).map((row) => row.rowNumber);
  const invalidAffiliation = rows.filter((row) => row.affiliation === undefined).map((row) => row.rowNumber);
  if (invalidClass.length) problems.push(`invalid class in row(s) ${invalidClass.join(', ')}`);
  if (invalidAffiliation.length) problems.push(`invalid affiliation in row(s) ${invalidAffiliation.join(', ')}`);
  const isOptional = (affiliation: string, classYear: number): boolean =>
    oracle.optionalCohorts.some((cohort) => cohort.affiliation === affiliation && cohort.classYear === classYear);
  const absent = oracle.affiliations.flatMap((affiliation) => oracle.classes
    .filter((classYear) => !rows.some((row) => row.affiliation === affiliation && row.classYear === classYear))
    .map((classYear) => ({ label: `${affiliation} ${classYear}`, optional: isOptional(affiliation, classYear) })));
  const missing = absent.filter((cohort) => !cohort.optional).map((cohort) => cohort.label);
  const waived = absent.filter((cohort) => cohort.optional).map((cohort) => cohort.label);
  if (missing.length) problems.push(`missing cohort(s): ${missing.join(', ')}`);
  const waivedNote = waived.length ? `; absent but optional (unsourced on the live web): ${waived.join(', ')}` : '';
  const requiredCount = oracle.affiliations.length * oracle.classes.length - oracle.optionalCohorts.length;
  return {
    name: COHORT_ASSERTION_NAME,
    passed: problems.length === 0,
    detail: (problems.length ? problems.join('; ') : `${rows.length} rows cover all ${requiredCount} required cohorts`) + waivedNote,
  };
}

function identityAssertion(rows: MemberRow[]): AssertionResult {
  const invalid = rows.filter((row) => !/^[\p{L}][\p{L}'’.\-]+(?:\s+[\p{L}][\p{L}'’.\-]+)+$/u.test(row.name)).map((row) => row.rowNumber);
  const keys = rows.filter((row) => row.affiliation && row.name).map((row) => `${row.affiliation}|${row.name.toLowerCase().replace(/\s+/g, ' ')}`);
  const duplicateCount = keys.length - new Set(keys).size;
  const problems = [
    invalid.length ? `implausible/empty full name in row(s) ${invalid.join(', ')}` : '',
    duplicateCount ? `${duplicateCount} duplicate affiliation/name pair(s)` : '',
  ].filter(Boolean);
  return {
    name: IDENTITY_ASSERTION_NAME,
    passed: rows.length > 0 && problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${rows.length} plausible, affiliation-unique names`,
  };
}

function detailAssertion(rows: MemberRow[], oracle: MitSororitiesOracle): AssertionResult {
  const majorCoverage = rows.length ? rows.filter((row) => !isEmptyish(row.major)).length / rows.length : 0;
  const enrichmentCoverage = rows.length
    ? rows.filter((row) => !isEmptyish(row.interests) || !isEmptyish(row.other)).length / rows.length
    : 0;
  const passed = majorCoverage >= oracle.minMajorCoverage && enrichmentCoverage >= oracle.minEnrichmentCoverage;
  return {
    name: DETAIL_ASSERTION_NAME,
    passed,
    detail: `major ${(majorCoverage * 100).toFixed(0)}% (min ${oracle.minMajorCoverage * 100}%); interests/other ${(enrichmentCoverage * 100).toFixed(0)}% (min ${oracle.minEnrichmentCoverage * 100}%)`,
  };
}

function normalizeClass(value: string, accepted: readonly number[]): number | undefined {
  const lower = value.toLowerCase();
  const year = accepted.find((candidate) => new RegExp(`(?:class\\s+of\\s+)?${candidate}`).test(lower));
  if (year) return year;
  if (/\bsenior\b/.test(lower)) return 2026;
  if (/\bjunior\b/.test(lower)) return 2027;
  return undefined;
}

function normalizeAffiliation(value: string, accepted: readonly string[]): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
  const aliases: Record<string, string[]> = {
    'Alpha Chi Omega': ['alphachiomega', 'axo'],
    'Alpha Phi': ['alphaphi', 'aphi'],
    'Delta Phi Epsilon': ['deltaphiepsilon', 'dphie', 'deephers'],
    'Kappa Alpha Theta': ['kappaalphatheta', 'kat', 'theta'],
    'Pi Beta Phi': ['pibetaphi', 'piphi'],
    'Sigma Kappa': ['sigmakappa', 'sk'],
  };
  return accepted.find((name) => aliases[name]?.includes(normalized));
}

function isEmptyish(value: string): boolean {
  return ['', '-', 'n/a', 'na', 'none', 'unknown', 'not found'].includes(value.trim().toLowerCase());
}

function failedCsvContent(detail: string): AssertionResult[] {
  return [COLUMN_ASSERTION_NAME, COHORT_ASSERTION_NAME, IDENTITY_ASSERTION_NAME, DETAIL_ASSERTION_NAME]
    .map((name) => ({ name, passed: false, detail }));
}

function asOracle(data: unknown): MitSororitiesOracle {
  const value = data as Partial<MitSororitiesOracle> | null;
  if (!value || !Array.isArray(value.affiliations) || value.affiliations.length !== 6 ||
      !value.affiliations.every((item) => typeof item === 'string') || !Array.isArray(value.classes) ||
      value.classes.length !== 2 || !Array.isArray(value.optionalCohorts) ||
      !value.optionalCohorts.every((item) => typeof item?.affiliation === 'string' && typeof item?.classYear === 'number') ||
      typeof value.minRows !== 'number' || typeof value.maxRows !== 'number' ||
      typeof value.minMajorCoverage !== 'number' || typeof value.minEnrichmentCoverage !== 'number') {
    throw new Error('mit_sororities grader was handed malformed oracle data');
  }
  return value as MitSororitiesOracle;
}
