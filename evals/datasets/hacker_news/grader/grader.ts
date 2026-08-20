import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '../../../grading/csv.js';
import {
  findArtifactByExtension,
  readManifest,
  verifyManifestHashes,
} from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import { HN_TOP_STORY_COUNT, type HackerNewsOracle } from '../oracle/hackerNewsClient.js';

/** Extension the grader looks for when locating the task's CSV deliverable. */
const CSV_EXTENSION = '.csv';

/** Minimum number of the oracle's titles that must appear in the CSV — one
 *  miss is tolerated because the live leaderboard can move between the run
 *  and grading time. */
const MIN_MATCHING_TITLES = HN_TOP_STORY_COUNT - 1;

/** The exact set of columns the task text asks for — no more, no fewer.
 *  The task names these columns explicitly, so success means exactly this
 *  shape: an extra column (e.g. a 'rank' column an agent added on its own
 *  initiative) is not a superset of success, it is a different shape. */
const REQUIRED_COLUMNS = ['title', 'url', 'points'] as const;

/** Name of the column-shape assertion, shared by every branch that emits it
 *  (found, missing CSV, unparseable CSV) so a lookup by name is stable. */
const COLUMN_ASSERTION_NAME = 'CSV has exactly the columns title, url, points (no more, no fewer)';

/**
 * Grade one Hacker News task trial. Per the standing rule, reads only the
 * run directory's manifest and artifacts — never the transcript. Locates
 * the CSV deliverable by extension (the agent chooses its own filename),
 * then checks its shape and content against the oracle's current top
 * stories with churn tolerance, plus the standing manifest-hash re-check.
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - a HackerNewsOracle with the current top stories;
 *   throws if it is not one (malformed oracle data is a harness bug, not a
 *   failed trial)
 * @returns six assertion results; a bad run yields failures with detail,
 *   never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asHackerNewsOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const csvEntry = findArtifactByExtension(manifest, CSV_EXTENSION);

  const assertions: AssertionResult[] = [
    {
      name: 'CSV artifact exists',
      passed: csvEntry !== undefined,
      detail:
        csvEntry !== undefined
          ? `found ${csvEntry.filename}`
          : `no .csv artifact found in the manifest`,
    },
  ];

  if (csvEntry === undefined) {
    assertions.push(
      failed(COLUMN_ASSERTION_NAME, 'no CSV artifact to check'),
      failed(`CSV has ${HN_TOP_STORY_COUNT} data rows`, 'no CSV artifact to check'),
      failed('at least 4 of 5 oracle titles appear in the CSV', 'no CSV artifact to check'),
      failed('url column entries are well-formed URLs', 'no CSV artifact to check'),
    );
    assertions.push(verifyManifestHashes(runDirPath, manifest));
    return assertions;
  }

  let header: string[];
  let rows: string[][];
  try {
    ({ header, rows } = parseCsv(readFileSync(join(runDirPath, csvEntry.filename), 'utf8')));
  } catch (err) {
    const detail = `${csvEntry.filename} could not be parsed as CSV: ${errMessage(err)}`;
    assertions.push(
      failed(COLUMN_ASSERTION_NAME, detail),
      failed(`CSV has ${HN_TOP_STORY_COUNT} data rows`, detail),
      failed('at least 4 of 5 oracle titles appear in the CSV', detail),
      failed('url column entries are well-formed URLs', detail),
      verifyManifestHashes(runDirPath, manifest),
    );
    return assertions;
  }

  const titleIdx = columnIndex(header, 'title');
  const urlIdx = columnIndex(header, 'url');

  assertions.push(columnSetAssertion(header));

  assertions.push({
    name: `CSV has ${HN_TOP_STORY_COUNT} data rows`,
    passed: rows.length === HN_TOP_STORY_COUNT,
    detail: `found ${rows.length} data row(s)`,
  });

  assertions.push(titleMatchAssertion(rows, titleIdx, oracle));
  assertions.push(urlWellFormedAssertion(rows, urlIdx));

  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

/** Check that at least MIN_MATCHING_TITLES of the oracle's titles appear
 * somewhere in the CSV's title column (order-independent — churn can
 * reorder the leaderboard as well as replace an entry). */
function titleMatchAssertion(
  rows: string[][],
  titleIdx: number,
  oracle: HackerNewsOracle,
): AssertionResult {
  const name = 'at least 4 of 5 oracle titles appear in the CSV';
  if (titleIdx === -1) {
    return failed(name, 'title column missing, cannot check titles');
  }
  const csvTitles = new Set(rows.map((r) => (r[titleIdx] ?? '').trim()));
  const oracleTitles = oracle.stories.map((s) => s.title);
  const matchCount = oracleTitles.filter((t) => csvTitles.has(t)).length;
  return {
    name,
    passed: matchCount >= MIN_MATCHING_TITLES,
    detail: `${matchCount} of ${oracleTitles.length} oracle titles found in the CSV`,
  };
}

/** Check that every data row's url-column cell parses as an http(s) URL. */
function urlWellFormedAssertion(rows: string[][], urlIdx: number): AssertionResult {
  const name = 'url column entries are well-formed URLs';
  if (urlIdx === -1) {
    return failed(name, 'url column missing, cannot check URLs');
  }
  if (rows.length === 0) {
    return { name, passed: true, detail: 'no rows to check' };
  }
  const malformed = rows
    .map((r, i) => ({ i, value: r[urlIdx] ?? '' }))
    .filter(({ value }) => !isWellFormedUrl(value));
  return {
    name,
    passed: malformed.length === 0,
    detail:
      malformed.length === 0
        ? `all ${rows.length} url cells are well-formed`
        : `malformed url(s) at row(s) ${malformed.map((m) => m.i + 1).join(', ')}`,
  };
}

function isWellFormedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function columnIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name);
}

/** Check that the CSV's header is exactly REQUIRED_COLUMNS — matched
 * case-insensitively, but as a set: any missing column or any column beyond
 * the required three fails this assertion, even though those extra values
 * (e.g. a 'rank' column) don't affect any other assertion, which locates
 * title/url by name regardless of what else is in the header. */
function columnSetAssertion(header: string[]): AssertionResult {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const required: readonly string[] = REQUIRED_COLUMNS;

  const missing = REQUIRED_COLUMNS.filter((c) => !normalized.includes(c));
  const extra = normalized.filter((h) => !required.includes(h));
  // Guards a header like "title,title,url,points" too: same set, wrong
  // cardinality, missed by missing/extra checks alone.
  const rightCardinality = normalized.length === REQUIRED_COLUMNS.length;

  const passed = missing.length === 0 && extra.length === 0 && rightCardinality;
  const problems = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
    extra.length > 0 ? `extra: ${extra.join(', ')}` : null,
    missing.length === 0 && extra.length === 0 && !rightCardinality
      ? 'duplicate column name(s)'
      : null,
  ].filter((p): p is string => p !== null);

  return {
    name: COLUMN_ASSERTION_NAME,
    passed,
    detail: passed
      ? `header: ${header.join(', ')}`
      : `${problems.join('; ')} (header: ${header.join(', ')})`,
  };
}

function failed(name: string, detail: string): AssertionResult {
  return { name, passed: false, detail };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asHackerNewsOracle(data: unknown): HackerNewsOracle {
  const stories = (data as { stories?: unknown } | null)?.stories;
  const valid =
    Array.isArray(stories) &&
    stories.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { title?: unknown }).title === 'string' &&
        typeof (s as { url?: unknown }).url === 'string' &&
        typeof (s as { score?: unknown }).score === 'number',
    );
  if (!valid) {
    throw new Error('hacker_news grader was handed malformed oracle data');
  }
  return data as HackerNewsOracle;
}
