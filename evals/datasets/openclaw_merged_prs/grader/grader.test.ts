import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { MergedPr, OpenClawMergedPrsOracle } from '../oracle/githubClient.js';
import { grade } from './grader.js';
import { byName, csvText } from '../../../testSupport.js';

/** Mirror the grader's public assertion names (this suite's convention:
 *  assert on names as plain strings). */
const COLUMNS =
  'CSV has exactly the columns pr_number, committer, reviewer, merger (no more, no fewer)';
const ROWS = 'CSV has 10 data rows with distinct valid PR numbers';
const MEMBERSHIP = "every CSV PR is in the oracle's recently-merged window";
const PEOPLE = 'committer and merger match the oracle for every detail-checked row';
const REVIEWER = 'reviewer cells name an actual reviewer for detail-checked rows with reviews';
const SCREENSHOTS = 'a valid PNG screenshot of each CSV PR page exists with its URL as provenance';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake image body'),
]);

/** 12 merged PRs, #900 (newest) down to #889; the newest 10 are detailed
 *  (mergedBy + reviewers present), #895 has no submitted reviews, and the
 *  last two are membership-only (undetailed), like a real oracle window. */
function makeOracle(): OpenClawMergedPrsOracle {
  const mergedWindow: MergedPr[] = [];
  for (let i = 0; i < 12; i++) {
    const number = 900 - i;
    const pr: MergedPr = {
      number,
      title: `PR ${number}`,
      url: `https://github.com/openclaw/openclaw/pull/${number}`,
      mergedAt: new Date(Date.UTC(2026, 7, 11, 12, 59 - i)).toISOString(),
      author: `author-${number}`,
    };
    if (i < 10) {
      pr.mergedBy = `merger-${number}`;
      pr.reviewers = number === 895 ? [] : [`rev-${number}`];
    }
    mergedWindow.push(pr);
  }
  return { mergedWindow };
}

const ORACLE = makeOracle();

/** The 10 newest window PRs as correct CSV rows: number, committer, reviewer, merger. */
function passingRows(): string[][] {
  return ORACLE.mergedWindow
    .slice(0, 10)
    .map((pr) => [`#${pr.number}`, pr.author, (pr.reviewers ?? []).join('; '), pr.mergedBy ?? '']);
}

const HEADER = ['pr_number', 'committer', 'reviewer', 'merger'];

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'merged-prs-grader-test-'));
  initManifest(runDir, 'merged prs grader test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function writeCsv(rows: string[][], header: string[] = HEADER): void {
  writeArtifact(runDir, 'artifacts/prs.csv', Buffer.from(csvText(header, rows)), {
    roles: ['requested_output'],
  });
}

function writeScreenshots(numbers: number[]): void {
  for (const n of numbers) {
    writeArtifact(runDir, `artifacts/pr_${n}.png`, PNG_BYTES, {
      sourceUrl: `https://github.com/openclaw/openclaw/pull/${n}`,
      roles: ['requested_output', 'evidence'],
    });
  }
}

function passingNumbers(): number[] {
  return ORACLE.mergedWindow.slice(0, 10).map((pr) => pr.number);
}

describe('openclaw_merged_prs grader', () => {
  it('passes every assertion on a run matching the oracle', async () => {
    writeCsv(passingRows());
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(results.length).toBeGreaterThanOrEqual(8);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails only the column assertion on an extra column', async () => {
    const rows = passingRows().map((r, i) => [...r, `note ${i}`]);
    writeCsv(rows, [...HEADER, 'notes']);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, COLUMNS).passed).toBe(false);
    expect(byName(results, COLUMNS).detail).toMatch(/extra: notes/);
    for (const name of [ROWS, MEMBERSHIP, PEOPLE, REVIEWER, SCREENSHOTS]) {
      expect(byName(results, name).passed).toBe(true);
    }
  });

  it('fails only the row assertion when a row is missing', async () => {
    writeCsv(passingRows().slice(0, 9));
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, ROWS).passed).toBe(false);
    expect(byName(results, ROWS).detail).toMatch(/9 data row/);
    expect(byName(results, MEMBERSHIP).passed).toBe(true);
    expect(byName(results, SCREENSHOTS).passed).toBe(true);
  });

  it('fails membership when a CSV PR is not recently merged', async () => {
    const rows = passingRows();
    rows[9] = ['#123', 'someone', '', 'someone-else'];
    writeCsv(rows);
    writeScreenshots([...passingNumbers().slice(0, 9), 123]);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, MEMBERSHIP).passed).toBe(false);
    expect(byName(results, MEMBERSHIP).detail).toMatch(/#123/);
    expect(byName(results, ROWS).passed).toBe(true);
    expect(byName(results, PEOPLE).passed).toBe(true);
    expect(byName(results, SCREENSHOTS).passed).toBe(true);
  });

  it('fails the people assertion when a merger is wrong', async () => {
    const rows = passingRows();
    rows[0]![3] = 'not-the-merger';
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, PEOPLE).passed).toBe(false);
    expect(byName(results, PEOPLE).detail).toMatch(/merger-900/);
    expect(byName(results, REVIEWER).passed).toBe(true);
  });

  it('accepts decorated people cells ("@login", "login (Name)")', async () => {
    const rows = passingRows();
    rows[0]![1] = `@${ORACLE.mergedWindow[0]!.author}`;
    rows[1]![3] = `${ORACLE.mergedWindow[1]!.mergedBy} (A Human)`;
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, PEOPLE).passed).toBe(true);
  });

  it('accepts a commit identity (bot committer) in the committer cell', async () => {
    const oracle = makeOracle();
    oracle.mergedWindow[0]!.commitIdentities = ['ampagent', `author-900`];
    const rows = passingRows();
    rows[0]![1] = 'ampagent';
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    expect(byName(await grade(runDir, oracle), PEOPLE).passed).toBe(true);
  });

  it('still fails a committer who is neither the author nor on any commit', async () => {
    const oracle = makeOracle();
    oracle.mergedWindow[0]!.commitIdentities = ['ampagent'];
    const rows = passingRows();
    rows[0]![1] = 'random-stranger';
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, oracle);
    expect(byName(results, PEOPLE).passed).toBe(false);
    expect(byName(results, PEOPLE).detail).toMatch(
      /neither author author-900 nor a commit identity/,
    );
  });

  it('fails the reviewer assertion when a reviewed PR names no actual reviewer', async () => {
    const rows = passingRows();
    rows[0]![2] = 'somebody-random';
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, REVIEWER).passed).toBe(false);
    expect(byName(results, REVIEWER).detail).toMatch(/rev-900/);
    expect(byName(results, PEOPLE).passed).toBe(true);
  });

  it('does not fail the reviewer assertion for a PR with no submitted reviews', async () => {
    const rows = passingRows();
    const reviewlessIdx = ORACLE.mergedWindow.findIndex((pr) => pr.number === 895);
    rows[reviewlessIdx]![2] = 'a-requested-but-silent-reviewer';
    writeCsv(rows);
    writeScreenshots(passingNumbers());

    const results = await grade(runDir, ORACLE);

    expect(byName(results, REVIEWER).passed).toBe(true);
  });

  it('fails the screenshot assertion when one PR lacks a provenance-matched PNG', async () => {
    writeCsv(passingRows());
    writeScreenshots(passingNumbers().slice(1)); // drop #900's screenshot

    const results = await grade(runDir, ORACLE);

    expect(byName(results, SCREENSHOTS).passed).toBe(false);
    expect(byName(results, SCREENSHOTS).detail).toMatch(/#900/);
    expect(byName(results, MEMBERSHIP).passed).toBe(true);
  });

  it('fails a screenshot whose provenance is a different PR page', async () => {
    writeCsv(passingRows());
    writeScreenshots(passingNumbers().slice(1));
    // A PNG exists as a requested output, but its sourceUrl is #9001's
    // page, not #900's — the provenance check, not the role filter, fails.
    writeArtifact(runDir, 'artifacts/pr_900.png', PNG_BYTES, {
      sourceUrl: 'https://github.com/openclaw/openclaw/pull/9001',
      roles: ['requested_output', 'evidence'],
    });

    const results = await grade(runDir, ORACLE);

    expect(byName(results, SCREENSHOTS).passed).toBe(false);
    expect(byName(results, SCREENSHOTS).detail).toMatch(/#900/);
  });

  it('fails every content assertion, with detail, when no CSV exists', async () => {
    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'CSV artifact exists').passed).toBe(false);
    for (const r of results) {
      if (r.name === 'manifest hashes verify') continue;
      expect(r.passed).toBe(false);
      expect(r.detail).not.toBe('');
    }

    // Malformed oracle data is a harness bug, not a failed trial.
    writeCsv(passingRows());
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
