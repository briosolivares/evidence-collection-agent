import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { HackerNewsOracle } from '../oracle/hackerNewsClient.js';
import { grade } from './grader.js';

/** Mirrors grader.ts's internal COLUMN_ASSERTION_NAME constant — kept here
 *  rather than exported, matching this suite's convention of asserting on
 *  the grader's public assertion names as plain strings. */
const COLUMN_ASSERTION_NAME = 'CSV has exactly the columns title, url, points (no more, no fewer)';

const ORACLE: HackerNewsOracle = {
  stories: [
    { id: 1, title: 'Story One', url: 'https://example.com/1', score: 500 },
    { id: 2, title: 'Story Two', url: 'https://example.com/2', score: 400 },
    { id: 3, title: 'Story Three', url: 'https://example.com/3', score: 300 },
    { id: 4, title: 'Story Four', url: 'https://example.com/4', score: 200 },
    { id: 5, title: 'Story Five', url: 'https://example.com/5', score: 100 },
  ],
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'hn-grader-test-'));
  initManifest(runDir, 'hn grader test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

/** Build CSV text from a header and rows (test data has no commas/quotes to escape). */
function csvText(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
}

function passingCsvRows(): string[][] {
  return ORACLE.stories.map((s, i) => [s.title, s.url, String(50 - i)]);
}

/** Publish the CSV deliverable where the grader looks: under artifacts/,
 *  with the requested_output role graders select deliverables by. */
function writeCsvArtifact(csv: string): void {
  writeArtifact(runDir, 'artifacts/hn.csv', Buffer.from(csv), { roles: ['requested_output'] });
}

function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no assertion named "${name}" in ${JSON.stringify(results)}`);
  return found;
}

describe('hacker_news grader', () => {
  it('passes every assertion on a well-formed run matching the oracle exactly', async () => {
    writeCsvArtifact(csvText(['title', 'url', 'points'], passingCsvRows()));

    const results = await grade(runDir, ORACLE);

    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails only the column-shape assertion when a required column is misnamed', async () => {
    // "points" renamed to "score" — title/url stay correct.
    const csv = csvText(['title', 'url', 'score'], passingCsvRows());
    writeCsvArtifact(csv);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, COLUMN_ASSERTION_NAME).passed).toBe(false);
    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
    expect(byName(results, 'url column entries are well-formed URLs').passed).toBe(true);
  });

  it('fails only the column-shape assertion when the CSV has an extra column beyond the three asked for', async () => {
    // A real agent produced exactly this: the three required columns plus
    // a self-initiated 'rank' column. The task named an exact shape, so
    // this must fail — even though title/url/points are all present and
    // correct, and every other assertion only looks up columns by name.
    const rows = ORACLE.stories.map((s, i) => [String(i + 1), s.title, s.url, String(50 - i)]);
    const csv = csvText(['rank', 'title', 'url', 'points'], rows);
    writeCsvArtifact(csv);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, COLUMN_ASSERTION_NAME).passed).toBe(false);
    expect(byName(results, COLUMN_ASSERTION_NAME).detail).toMatch(/extra/);
    expect(byName(results, 'CSV has 5 data rows').passed).toBe(true);
    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
    expect(byName(results, 'url column entries are well-formed URLs').passed).toBe(true);
  });

  it('fails only the row-count assertion when one row is missing', async () => {
    const rows = passingCsvRows().slice(0, 4); // 4 of 5, all still oracle titles
    writeCsvArtifact(csvText(['title', 'url', 'points'], rows));

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'CSV has 5 data rows').passed).toBe(false);
    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
    expect(byName(results, COLUMN_ASSERTION_NAME).passed).toBe(true);
  });

  it('passes the churn-tolerance boundary at exactly 4 of 5 titles matching', async () => {
    const rows = passingCsvRows();
    rows[4] = ['A Totally Different Story', 'https://example.com/other', '10']; // replaces Story Five
    writeCsvArtifact(csvText(['title', 'url', 'points'], rows));

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
    expect(byName(results, 'CSV has 5 data rows').passed).toBe(true);
  });

  it('fails when only 3 of 5 titles match the oracle', async () => {
    const rows = passingCsvRows();
    rows[3] = ['A Different Story A', 'https://example.com/other-a', '10'];
    rows[4] = ['A Different Story B', 'https://example.com/other-b', '5'];
    writeCsvArtifact(csvText(['title', 'url', 'points'], rows));

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(false);
  });

  it('fails the well-formed-URL assertion when a url cell is not a URL', async () => {
    const rows = passingCsvRows();
    rows[0]![1] = 'not-a-url';
    writeCsvArtifact(csvText(['title', 'url', 'points'], rows));

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'url column entries are well-formed URLs').passed).toBe(false);
    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
  });

  it('fails every content assertion, with detail, when no CSV artifact exists', async () => {
    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'CSV artifact exists').passed).toBe(false);
    for (const r of results) {
      if (r.name === 'manifest hashes verify') continue;
      expect(r.passed).toBe(false);
      expect(r.detail).not.toBe('');
    }
  });

  it('fails only the manifest-hash assertion when the CSV is tampered with after capture', async () => {
    const csv = csvText(['title', 'url', 'points'], passingCsvRows());
    writeCsvArtifact(csv);
    // Tamper behind the manifest's back: change only the points values, which
    // no other assertion inspects, so every other assertion still passes.
    const tampered = csv.replace(/,50\n/, ',999\n');
    expect(tampered).not.toBe(csv);
    writeFileSync(join(runDir, 'artifacts', 'hn.csv'), tampered);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'manifest hashes verify').passed).toBe(false);
    expect(byName(results, 'CSV has 5 data rows').passed).toBe(true);
    expect(byName(results, 'at least 4 of 5 oracle titles appear in the CSV').passed).toBe(true);
    expect(byName(results, 'url column entries are well-formed URLs').passed).toBe(true);
  });

  it('throws on malformed oracle data — a harness bug, not a failed trial', async () => {
    writeCsvArtifact(csvText(['title', 'url', 'points'], passingCsvRows()));
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
