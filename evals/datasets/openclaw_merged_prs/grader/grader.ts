import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest } from '../../../../src/run/artifacts.js';
import { parseCsv } from '../../../grading/csv.js';
import {
  exactColumnsAssertion,
  exactColumnsAssertionName,
} from '../../../grading/csvAssertions.js';
import {
  findArtifactByExtension,
  readManifest,
  requestedOutputs,
  verifyManifestHashes,
} from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import {
  REPO_NAME,
  REPO_OWNER,
  REQUIRED_ROW_COUNT,
  type MergedPr,
  type OpenClawMergedPrsOracle,
} from '../oracle/githubClient.js';

/** The 8-byte signature every valid PNG file starts with. */
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The exact columns the task text names, in task order. */
const REQUIRED_COLUMNS = ['pr_number', 'committer', 'reviewer', 'merger'] as const;

const COLUMN_ASSERTION_NAME = exactColumnsAssertionName(REQUIRED_COLUMNS);
const ROWS_ASSERTION_NAME = `CSV has ${REQUIRED_ROW_COUNT} data rows with distinct valid PR numbers`;
const MEMBERSHIP_ASSERTION_NAME = "every CSV PR is in the oracle's recently-merged window";
const PEOPLE_ASSERTION_NAME = 'committer and merger match the oracle for every detail-checked row';
const REVIEWER_ASSERTION_NAME =
  'reviewer cells name an actual reviewer for detail-checked rows with reviews';
const SCREENSHOT_ASSERTION_NAME =
  'a valid PNG screenshot of each CSV PR page exists with its URL as provenance';

/** One CSV data row, resolved to its parsed PR number (when valid). */
interface CsvPrRow {
  rowIndex: number;
  prNumber: number | undefined;
  committer: string;
  reviewer: string;
  merger: string;
}

/**
 * Grade one merged-PRs task trial. Per the standing rule, reads only the run
 * directory's manifest and artifacts — never the transcript. Checks the CSV
 * deliverable's exact shape, that its PRs really are recently merged
 * OpenClaw PRs, that committer/reviewer/merger agree with the oracle for
 * every row the oracle carries detail for, and that each listed PR has a
 * PNG screenshot whose manifest provenance is that PR's page. Whether a
 * screenshot is genuinely *full-page* is Tier C, left to the human overlay.
 *
 * Churn tolerance: the oracle window holds MERGED_WINDOW_SIZE recently
 * merged PRs, several times the task's 10, so merges landing between the
 * run and grading cannot push a correctly-reported PR out of membership;
 * people-checks apply only to rows inside the oracle's detailed subset.
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - an OpenClawMergedPrsOracle; throws if it is not one
 *   (malformed oracle data is a harness bug, not a failed trial)
 * @returns eight assertion results; a bad run yields failures with detail,
 *   never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asMergedPrsOracle(oracleData);
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
  const validNumbers = rows.map((r) => r.prNumber).filter((n): n is number => n !== undefined);

  assertions.push(exactColumnsAssertion(header, REQUIRED_COLUMNS));
  assertions.push(rowShapeAssertion(rows, validNumbers));
  assertions.push(membershipAssertion(validNumbers, oracle));
  assertions.push(peopleAssertion(rows, oracle));
  assertions.push(reviewerAssertion(rows, oracle));
  assertions.push(screenshotAssertion(runDirPath, manifest, validNumbers));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

/** Locate each row's cells by column name and parse its PR number. */
function resolveRows(header: string[], rawRows: string[][]): CsvPrRow[] {
  const idx = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name);
  const numberIdx = idx('pr_number');
  const committerIdx = idx('committer');
  const reviewerIdx = idx('reviewer');
  const mergerIdx = idx('merger');

  const cell = (row: string[], i: number): string => (i === -1 ? '' : (row[i] ?? '').trim());
  return rawRows.map((row, rowIndex) => ({
    rowIndex,
    prNumber: parsePrNumber(cell(row, numberIdx)),
    committer: cell(row, committerIdx),
    reviewer: cell(row, reviewerIdx),
    merger: cell(row, mergerIdx),
  }));
}

/** Parse a pr_number cell: a bare integer, optionally prefixed with '#'. */
function parsePrNumber(cellText: string): number | undefined {
  const match = /^#?(\d+)$/.exec(cellText);
  return match ? Number(match[1]) : undefined;
}

function rowShapeAssertion(rows: CsvPrRow[], validNumbers: number[]): AssertionResult {
  const problems: string[] = [];
  if (rows.length !== REQUIRED_ROW_COUNT) problems.push(`found ${rows.length} data row(s)`);
  const invalidCount = rows.length - validNumbers.length;
  if (invalidCount > 0) problems.push(`${invalidCount} row(s) lack a parseable PR number`);
  if (new Set(validNumbers).size !== validNumbers.length) problems.push('duplicate PR number(s)');
  return {
    name: ROWS_ASSERTION_NAME,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${rows.length} rows, all PR numbers valid and distinct`
        : problems.join('; '),
  };
}

function membershipAssertion(
  validNumbers: number[],
  oracle: OpenClawMergedPrsOracle,
): AssertionResult {
  const windowNumbers = new Set(oracle.mergedWindow.map((pr) => pr.number));
  const unknown = validNumbers.filter((n) => !windowNumbers.has(n));
  if (validNumbers.length === 0) {
    return {
      name: MEMBERSHIP_ASSERTION_NAME,
      passed: false,
      detail: 'no valid PR numbers to check',
    };
  }
  return {
    name: MEMBERSHIP_ASSERTION_NAME,
    passed: unknown.length === 0,
    detail:
      unknown.length === 0
        ? `all ${validNumbers.length} CSV PR(s) are in the window of ${oracle.mergedWindow.length} recently merged`
        : `not recently-merged OpenClaw PR(s): ${unknown.map((n) => `#${n}`).join(', ')}`,
  };
}

/** Rows whose PR the oracle carries detail for (mergedBy/reviewers fetched). */
function detailCheckedRows(
  rows: CsvPrRow[],
  oracle: OpenClawMergedPrsOracle,
): Array<{ row: CsvPrRow; pr: MergedPr }> {
  const detailed = new Map(
    oracle.mergedWindow.filter((pr) => pr.reviewers !== undefined).map((pr) => [pr.number, pr]),
  );
  return rows.flatMap((row) => {
    const pr = row.prNumber === undefined ? undefined : detailed.get(row.prNumber);
    return pr === undefined ? [] : [{ row, pr }];
  });
}

function peopleAssertion(rows: CsvPrRow[], oracle: OpenClawMergedPrsOracle): AssertionResult {
  const checked = detailCheckedRows(rows, oracle);
  if (checked.length === 0) {
    return {
      name: PEOPLE_ASSERTION_NAME,
      passed: true,
      detail: "no CSV PR fell in the oracle's detailed subset; nothing to contradict",
    };
  }
  const problems: string[] = [];
  for (const { row, pr } of checked) {
    // "Committer" is ambiguous on a PR page: the opening author or the
    // commits' git identities (bot-assisted PRs differ — e.g. ampagent
    // commits on a PR steipete opened). Either is a faithful reading.
    const committerNames = [pr.author, ...(pr.commitIdentities ?? [])];
    if (!committerNames.some((name) => mentionsLogin(row.committer, name))) {
      problems.push(
        `#${pr.number}: committer "${row.committer}" names neither author ` +
          `${pr.author} nor a commit identity`,
      );
    }
    if (pr.mergedBy !== undefined && !mentionsLogin(row.merger, pr.mergedBy)) {
      problems.push(`#${pr.number}: merger "${row.merger}" does not name ${pr.mergedBy}`);
    }
  }
  return {
    name: PEOPLE_ASSERTION_NAME,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${checked.length} row(s) checked against PR details`
        : problems.join('; '),
  };
}

function reviewerAssertion(rows: CsvPrRow[], oracle: OpenClawMergedPrsOracle): AssertionResult {
  // Only rows whose PR has at least one submitted review are checkable: a PR
  // page's sidebar also shows *requested* reviewers who never reviewed, so an
  // agent naming one of those on a review-less PR cannot be called wrong.
  const checked = detailCheckedRows(rows, oracle).filter(
    ({ pr }) => (pr.reviewers ?? []).length > 0,
  );
  if (checked.length === 0) {
    return {
      name: REVIEWER_ASSERTION_NAME,
      passed: true,
      detail: 'no detail-checked CSV PR has submitted reviews; nothing to contradict',
    };
  }
  const problems = checked
    .filter(({ row, pr }) => !pr.reviewers!.some((login) => mentionsLogin(row.reviewer, login)))
    .map(
      ({ row, pr }) =>
        `#${pr.number}: reviewer "${row.reviewer}" names none of ${pr.reviewers!.join(', ')}`,
    );
  return {
    name: REVIEWER_ASSERTION_NAME,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${checked.length} row(s) checked against submitted reviews`
        : problems.join('; '),
  };
}

function screenshotAssertion(
  runDirPath: string,
  manifest: Manifest,
  validNumbers: number[],
): AssertionResult {
  if (validNumbers.length === 0) {
    return {
      name: SCREENSHOT_ASSERTION_NAME,
      passed: false,
      detail: 'no valid PR numbers to check',
    };
  }
  // Screenshots the task asks for are requested outputs (typically published
  // with both roles); evidence-only captures do not satisfy the request.
  const missing = validNumbers.filter(
    (n) =>
      !requestedOutputs(manifest).some(
        (a) =>
          a.filename.toLowerCase().endsWith('.png') &&
          a.sourceUrl !== undefined &&
          new RegExp(`${REPO_OWNER}/${REPO_NAME}/pull/${n}(?![0-9])`).test(a.sourceUrl) &&
          isPngOnDisk(runDirPath, a.filename),
      ),
  );
  return {
    name: SCREENSHOT_ASSERTION_NAME,
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${validNumbers.length} CSV PR(s) have a provenance-matched PNG`
        : `no provenance-matched PNG for ${missing.map((n) => `#${n}`).join(', ')}`,
  };
}

function isPngOnDisk(runDirPath: string, filename: string): boolean {
  const absPath = join(runDirPath, filename);
  if (!existsSync(absPath)) return false;
  return readFileSync(absPath).subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES);
}

/** Whether a cell names a login: case-insensitive, tolerant of decoration
 * ("@login", "login (Display Name)") but not of the login merely appearing
 * inside a longer login-shaped token. */
function mentionsLogin(cellText: string, login: string): boolean {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'i').test(cellText);
}

function allContentAssertionsFailed(detail: string): AssertionResult[] {
  return [
    COLUMN_ASSERTION_NAME,
    ROWS_ASSERTION_NAME,
    MEMBERSHIP_ASSERTION_NAME,
    PEOPLE_ASSERTION_NAME,
    REVIEWER_ASSERTION_NAME,
    SCREENSHOT_ASSERTION_NAME,
  ].map((name) => ({ name, passed: false, detail }));
}

function asMergedPrsOracle(data: unknown): OpenClawMergedPrsOracle {
  const window = (data as { mergedWindow?: unknown } | null)?.mergedWindow;
  const valid =
    Array.isArray(window) &&
    window.length > 0 &&
    window.every(
      (pr) =>
        typeof pr === 'object' &&
        pr !== null &&
        typeof (pr as { number?: unknown }).number === 'number' &&
        typeof (pr as { author?: unknown }).author === 'string' &&
        typeof (pr as { mergedAt?: unknown }).mergedAt === 'string',
    );
  if (!valid) {
    throw new Error('openclaw_merged_prs grader was handed malformed oracle data');
  }
  return data as OpenClawMergedPrsOracle;
}
