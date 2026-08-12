import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from '../../../grading/csv.js';
import { exactColumnsAssertion, exactColumnsAssertionName } from '../../../grading/csvAssertions.js';
import { findArtifactByExtension, readManifest, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { ElonTweetsOracle } from '../oracle/oracle.js';

const REQUIRED_COLUMNS = ['text', 'likes', 'time_posted'] as const;
const COLUMN_ASSERTION_NAME = exactColumnsAssertionName(REQUIRED_COLUMNS);
const ROWS_ASSERTION_NAME = 'CSV has a plausible non-empty set of distinct tweets';
const TEXT_ASSERTION_NAME = 'every text cell is non-empty and tweet texts are distinct';
const LIKES_ASSERTION_NAME = 'every likes cell is a non-negative integer or compact X count';
const TIME_ASSERTION_NAME = "every time_posted cell is a plausible time from the run's day";

interface TweetRow {
  rowNumber: number;
  text: string;
  likes: string;
  timePosted: string;
}

/** Tier-B grader: strict output shape plus row-level and cross-row
 * consistency. Whether the rows are truly all of @elonmusk's posts is not
 * independently observable without X API access and remains human review. */
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
    const detail = `${csvEntry.filename} could not be parsed as CSV: ${error instanceof Error ? error.message : String(error)}`;
    return [...assertions, ...failedContent(detail), verifyManifestHashes(runDirPath, manifest)];
  }

  const rows = resolveRows(header, rawRows);
  assertions.push(exactColumnsAssertion(header, REQUIRED_COLUMNS));
  assertions.push(rowCountAssertion(rows, oracle));
  assertions.push(textAssertion(rows));
  assertions.push(likesAssertion(rows));
  assertions.push(timeAssertion(rows, manifest.startedAt, manifest.finishedAt, oracle));
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

function resolveRows(header: string[], rawRows: string[][]): TweetRow[] {
  const index = (name: string): number => header.findIndex((cell) => cell.trim().toLowerCase() === name);
  const textIndex = index('text');
  const likesIndex = index('likes');
  const timeIndex = index('time_posted');
  const cell = (row: string[], i: number): string => i < 0 ? '' : (row[i] ?? '').trim();
  return rawRows.map((row, i) => ({
    rowNumber: i + 1,
    text: cell(row, textIndex),
    likes: cell(row, likesIndex),
    timePosted: cell(row, timeIndex),
  }));
}

function rowCountAssertion(rows: TweetRow[], oracle: ElonTweetsOracle): AssertionResult {
  const passed = rows.length >= oracle.minRows && rows.length <= oracle.maxRows;
  return {
    name: ROWS_ASSERTION_NAME,
    passed,
    detail: passed
      ? `${rows.length} row(s), within ${oracle.minRows}–${oracle.maxRows}; completeness is human-reviewed`
      : `found ${rows.length} row(s), expected ${oracle.minRows}–${oracle.maxRows}`,
  };
}

function textAssertion(rows: TweetRow[]): AssertionResult {
  const empty = rows.filter((row) => row.text === '').map((row) => row.rowNumber);
  const normalized = rows.filter((row) => row.text !== '').map((row) => row.text.replace(/\s+/g, ' ').toLowerCase());
  const duplicateCount = normalized.length - new Set(normalized).size;
  const problems = [
    empty.length ? `empty text in row(s) ${empty.join(', ')}` : '',
    duplicateCount ? `${duplicateCount} duplicate tweet text(s)` : '',
  ].filter(Boolean);
  return {
    name: TEXT_ASSERTION_NAME,
    passed: problems.length === 0 && rows.length > 0,
    detail: problems.length ? problems.join('; ') : `${rows.length} non-empty distinct text cell(s)`,
  };
}

function likesAssertion(rows: TweetRow[]): AssertionResult {
  const invalid = rows.filter((row) => !isLikeCount(row.likes)).map((row) => `row ${row.rowNumber}: "${row.likes}"`);
  return {
    name: LIKES_ASSERTION_NAME,
    passed: invalid.length === 0 && rows.length > 0,
    detail: invalid.length ? invalid.join('; ') : `${rows.length} like count(s) parsed`,
  };
}

function isLikeCount(value: string): boolean {
  const compact = value.trim().replace(/\s+likes?$/i, '').replace(/\s/g, '');
  return /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?[KMB]?$/.test(compact.toUpperCase());
}

function timeAssertion(
  rows: TweetRow[],
  startedAt: string,
  finishedAt: string | undefined,
  oracle: ElonTweetsOracle,
): AssertionResult {
  const acceptedDates = new Set<string>();
  for (const iso of [startedAt, finishedAt].filter((value): value is string => value !== undefined)) {
    const date = new Date(iso);
    for (const timeZone of oracle.acceptedTimeZones) acceptedDates.add(dateKey(date, timeZone));
  }
  const invalid = rows
    .filter((row) => !isPlausibleTodayTime(row.timePosted, acceptedDates))
    .map((row) => `row ${row.rowNumber}: "${row.timePosted}"`);
  return {
    name: TIME_ASSERTION_NAME,
    passed: invalid.length === 0 && rows.length > 0,
    detail: invalid.length
      ? `${invalid.join('; ')}; accepted date(s): ${[...acceptedDates].join(', ')}`
      : `${rows.length} time value(s) agree with ${[...acceptedDates].join(' or ')}`,
  };
}

function isPlausibleTodayTime(value: string, acceptedDates: Set<string>): boolean {
  const text = value.trim();
  if (/^(?:just now|now|\d+\s*(?:s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hr|hour)s?\s*(?:ago)?)$/i.test(text)) return true;
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*(?:am|pm))?$|^(?:1[0-2]|0?[1-9]):[0-5]\d\s*(?:am|pm)$/i.test(text)) return true;
  const datePrefix = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  if (datePrefix) return acceptedDates.has(datePrefix) && !Number.isNaN(Date.parse(text));
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return false;
  const date = new Date(parsed);
  return [...acceptedDates].some((key) => key === dateKey(date, 'UTC') || key === dateKey(date, 'America/Los_Angeles'));
}

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function failedContent(detail: string): AssertionResult[] {
  return [COLUMN_ASSERTION_NAME, ROWS_ASSERTION_NAME, TEXT_ASSERTION_NAME, LIKES_ASSERTION_NAME, TIME_ASSERTION_NAME]
    .map((name) => ({ name, passed: false, detail }));
}

function asOracle(data: unknown): ElonTweetsOracle {
  const value = data as Partial<ElonTweetsOracle> | null;
  if (!value || value.accountHandle !== 'elonmusk' || typeof value.minRows !== 'number' ||
      typeof value.maxRows !== 'number' || !Array.isArray(value.acceptedTimeZones) ||
      !value.acceptedTimeZones.every((zone) => typeof zone === 'string')) {
    throw new Error('elon_tweets grader was handed malformed oracle data');
  }
  return value as ElonTweetsOracle;
}
