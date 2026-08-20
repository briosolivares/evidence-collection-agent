import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '../../../grading/csv.js';
import {
  exactColumnsAssertion,
  exactColumnsAssertionName,
} from '../../../grading/csvAssertions.js';
import {
  findArtifactByExtension,
  readManifest,
  verifyManifestHashes,
} from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import {
  MIN_MATCHING_HANDLES,
  REQUIRED_ROW_COUNT,
  type OpenClawContributorsOracle,
} from '../oracle/githubClient.js';

/** The exact columns the task text names, in task order. */
const REQUIRED_COLUMNS = ['github_handle', 'name', 'linkedin_url'] as const;

const COLUMN_ASSERTION_NAME = exactColumnsAssertionName(REQUIRED_COLUMNS);
const ROWS_ASSERTION_NAME = `CSV has ${REQUIRED_ROW_COUNT} data rows with distinct non-empty handles`;
const HANDLES_ASSERTION_NAME = `at least ${MIN_MATCHING_HANDLES} of the ${REQUIRED_ROW_COUNT} handles are oracle top contributors`;
const NAMES_ASSERTION_NAME =
  'name cells agree with GitHub profile names wherever both sides have one';
const LINKEDIN_ASSERTION_NAME = 'linkedin_url cells are empty or well-formed linkedin.com URLs';

/** Cell values that count as "no answer" rather than a wrong answer. */
const EMPTYISH = new Set(['', '-', 'n/a', 'na', 'none', 'unknown', 'not found']);

/** One CSV data row, cells located by column name. */
interface ContributorRow {
  rowIndex: number;
  /** The handle, normalized: trimmed, leading '@' stripped, lowercased. */
  handle: string;
  name: string;
  linkedinUrl: string;
}

/**
 * Grade one contributors task trial. Per the standing rule, reads only the
 * run directory's manifest and artifacts — never the transcript. Checks the
 * CSV deliverable's exact shape, that its handles really are top OpenClaw
 * contributors (with a tolerance window for ranking-edge disagreements such
 * as bot filtering), and that name cells agree with the contributors'
 * public GitHub profile names wherever both the CSV and the profile have
 * one. LinkedIn URLs have no machine oracle — GitHub does not know them —
 * so that column is checked for shape only, with correctness left to the
 * human overlay (documented in the oracle client).
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - an OpenClawContributorsOracle; throws if it is not
 *   one (malformed oracle data is a harness bug, not a failed trial)
 * @returns seven assertion results; a bad run yields failures with detail,
 *   never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asContributorsOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const csvEntry = findArtifactByExtension(manifest, '.csv');

  const assertions: AssertionResult[] = [
    {
      name: 'CSV artifact exists',
      passed: csvEntry !== undefined,
      detail:
        csvEntry !== undefined
          ? `found ${csvEntry.filename}`
          : 'no .csv artifact found in the manifest',
    },
  ];

  if (csvEntry === undefined) {
    return [
      ...assertions,
      ...allContentAssertionsFailed('no CSV artifact to check'),
      verifyManifestHashes(runDirPath, manifest),
    ];
  }

  let header: string[];
  let rawRows: string[][];
  try {
    ({ header, rows: rawRows } = parseCsv(
      readFileSync(join(runDirPath, csvEntry.filename), 'utf8'),
    ));
  } catch (err) {
    const detail = `${csvEntry.filename} could not be parsed as CSV: ${err instanceof Error ? err.message : String(err)}`;
    return [
      ...assertions,
      ...allContentAssertionsFailed(detail),
      verifyManifestHashes(runDirPath, manifest),
    ];
  }

  const rows = resolveRows(header, rawRows);

  assertions.push(exactColumnsAssertion(header, REQUIRED_COLUMNS));
  assertions.push(rowShapeAssertion(rows));
  assertions.push(handleMatchAssertion(rows, oracle));
  assertions.push(nameMatchAssertion(rows, oracle));
  assertions.push(linkedinShapeAssertion(rows));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

/** Locate each row's cells by column name. */
function resolveRows(header: string[], rawRows: string[][]): ContributorRow[] {
  const idx = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name);
  const handleIdx = idx('github_handle');
  const nameIdx = idx('name');
  const linkedinIdx = idx('linkedin_url');

  const cell = (row: string[], i: number): string => (i === -1 ? '' : (row[i] ?? '').trim());
  return rawRows.map((row, rowIndex) => ({
    rowIndex,
    handle: cell(row, handleIdx).replace(/^@/, '').toLowerCase(),
    name: cell(row, nameIdx),
    linkedinUrl: cell(row, linkedinIdx),
  }));
}

function rowShapeAssertion(rows: ContributorRow[]): AssertionResult {
  const problems: string[] = [];
  if (rows.length !== REQUIRED_ROW_COUNT) problems.push(`found ${rows.length} data row(s)`);
  const nonEmpty = rows.filter((r) => r.handle !== '');
  if (nonEmpty.length < rows.length)
    problems.push(`${rows.length - nonEmpty.length} row(s) have an empty handle`);
  if (new Set(nonEmpty.map((r) => r.handle)).size !== nonEmpty.length)
    problems.push('duplicate handle(s)');
  return {
    name: ROWS_ASSERTION_NAME,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${rows.length} rows, all handles non-empty and distinct`
        : problems.join('; '),
  };
}

function handleMatchAssertion(
  rows: ContributorRow[],
  oracle: OpenClawContributorsOracle,
): AssertionResult {
  const oracleLogins = new Set(oracle.contributors.map((c) => c.login.toLowerCase()));
  const matched = rows.filter((r) => r.handle !== '' && oracleLogins.has(r.handle));
  const unmatched = rows.filter((r) => r.handle !== '' && !oracleLogins.has(r.handle));
  return {
    name: HANDLES_ASSERTION_NAME,
    passed: matched.length >= MIN_MATCHING_HANDLES,
    detail:
      `${matched.length} of ${rows.length} handles found among the oracle's top ${oracle.contributors.length}` +
      (unmatched.length > 0 ? `; not found: ${unmatched.map((r) => r.handle).join(', ')}` : ''),
  };
}

function nameMatchAssertion(
  rows: ContributorRow[],
  oracle: OpenClawContributorsOracle,
): AssertionResult {
  const byLogin = new Map(oracle.contributors.map((c) => [c.login.toLowerCase(), c]));
  const comparable = rows.flatMap((row) => {
    const oracleName = byLogin.get(row.handle)?.name;
    const cellHasName = !EMPTYISH.has(row.name.toLowerCase());
    return typeof oracleName === 'string' && cellHasName ? [{ row, oracleName }] : [];
  });
  if (comparable.length === 0) {
    return {
      name: NAMES_ASSERTION_NAME,
      passed: true,
      detail: 'no row has both a CSV name and an oracle profile name; nothing to contradict',
    };
  }
  const mismatches = comparable
    .filter(({ row, oracleName }) => !namesAgree(row.name, oracleName))
    .map(({ row, oracleName }) => `${row.handle}: "${row.name}" vs profile "${oracleName}"`);
  return {
    name: NAMES_ASSERTION_NAME,
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${comparable.length} name(s) checked against profiles`
        : mismatches.join('; '),
  };
}

/** Case-insensitive containment either way: "Ada Lovelace" agrees with
 * "Ada Lovelace (ada)" and with "Ada". */
function namesAgree(cellName: string, profileName: string): boolean {
  const a = cellName.toLowerCase();
  const b = profileName.toLowerCase();
  return a.includes(b) || b.includes(a);
}

function linkedinShapeAssertion(rows: ContributorRow[]): AssertionResult {
  const bad = rows
    .filter((r) => !EMPTYISH.has(r.linkedinUrl.toLowerCase()) && !isLinkedinUrl(r.linkedinUrl))
    .map((r) => `row ${r.rowIndex + 1}: "${r.linkedinUrl}"`);
  return {
    name: LINKEDIN_ASSERTION_NAME,
    passed: bad.length === 0,
    detail:
      bad.length === 0
        ? `${rows.length} cell(s) checked (shape only; content is Tier C)`
        : bad.join('; '),
  };
}

function isLinkedinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'linkedin.com' || host.endsWith('.linkedin.com'))
    );
  } catch {
    return false;
  }
}

function allContentAssertionsFailed(detail: string): AssertionResult[] {
  return [
    COLUMN_ASSERTION_NAME,
    ROWS_ASSERTION_NAME,
    HANDLES_ASSERTION_NAME,
    NAMES_ASSERTION_NAME,
    LINKEDIN_ASSERTION_NAME,
  ].map((name) => ({ name, passed: false, detail }));
}

function asContributorsOracle(data: unknown): OpenClawContributorsOracle {
  const contributors = (data as { contributors?: unknown } | null)?.contributors;
  const valid =
    Array.isArray(contributors) &&
    contributors.length > 0 &&
    contributors.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { login?: unknown }).login === 'string' &&
        typeof (c as { contributions?: unknown }).contributions === 'number',
    );
  if (!valid) {
    throw new Error('openclaw_contributors grader was handed malformed oracle data');
  }
  return data as OpenClawContributorsOracle;
}
