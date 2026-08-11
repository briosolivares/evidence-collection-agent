import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { Contributor, OpenClawContributorsOracle } from '../oracle/githubClient.js';
import { grade } from './grader.js';

/** Mirror the grader's public assertion names (this suite's convention:
 *  assert on names as plain strings). */
const COLUMNS = 'CSV has exactly the columns github_handle, name, linkedin_url (no more, no fewer)';
const ROWS = 'CSV has 30 data rows with distinct non-empty handles';
const HANDLES = 'at least 25 of the 30 handles are oracle top contributors';
const NAMES = 'name cells agree with GitHub profile names wherever both sides have one';
const LINKEDIN = 'linkedin_url cells are empty or well-formed linkedin.com URLs';

/** 40 contributors, dev-1 (most commits) .. dev-40; every third profile has
 *  no public name, like real GitHub. */
function makeOracle(): OpenClawContributorsOracle {
  const contributors: Contributor[] = Array.from({ length: 40 }, (_, i) => ({
    login: `dev-${i + 1}`,
    contributions: 4000 - i * 37,
    name: i % 3 === 2 ? null : `Dev Number${i + 1}`,
  }));
  return { contributors };
}

const ORACLE = makeOracle();

/** The oracle's top 30 as correct CSV rows: handle, name, linkedin_url. */
function passingRows(): string[][] {
  return ORACLE.contributors.slice(0, 30).map((c) => [
    c.login,
    c.name ?? '',
    `https://www.linkedin.com/in/${c.login}`,
  ]);
}

function csvText(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
}

const HEADER = ['github_handle', 'name', 'linkedin_url'];

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'contributors-grader-test-'));
  initManifest(runDir, 'contributors grader test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function writeCsv(rows: string[][], header: string[] = HEADER): void {
  writeArtifact(runDir, 'contributors.csv', Buffer.from(csvText(header, rows)));
}

function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no assertion named "${name}"`);
  return found;
}

describe('openclaw_contributors grader', () => {
  it('passes every assertion on a run matching the oracle', async () => {
    writeCsv(passingRows());

    const results = await grade(runDir, ORACLE);

    expect(results.length).toBeGreaterThanOrEqual(7);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails only the column assertion on an extra column', async () => {
    const rows = passingRows().map((r) => [...r, '42']);
    writeCsv(rows, [...HEADER, 'commits']);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, COLUMNS).passed).toBe(false);
    expect(byName(results, COLUMNS).detail).toMatch(/extra: commits/);
    for (const name of [ROWS, HANDLES, NAMES, LINKEDIN]) {
      expect(byName(results, name).passed).toBe(true);
    }
  });

  it('fails only the row assertion when rows are missing or duplicated', async () => {
    const rows = passingRows().slice(0, 29);
    rows.push([...rows[0]!]); // 30 rows again, but a duplicate handle
    writeCsv(rows);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, ROWS).passed).toBe(false);
    expect(byName(results, ROWS).detail).toMatch(/duplicate/);
    expect(byName(results, HANDLES).passed).toBe(true);
  });

  it('tolerates up to 5 off-window handles, then fails at 6', async () => {
    const withOffWindow = (count: number): string[][] => {
      const rows = passingRows();
      for (let i = 0; i < count; i++) {
        rows[i] = [`stranger-${i}`, 'Some Stranger', ''];
      }
      return rows;
    };

    writeCsv(withOffWindow(5));
    expect(byName(await grade(runDir, ORACLE), HANDLES).passed).toBe(true);

    writeCsv(withOffWindow(6));
    const results = await grade(runDir, ORACLE);
    expect(byName(results, HANDLES).passed).toBe(false);
    expect(byName(results, HANDLES).detail).toMatch(/stranger-0/);
  });

  it('accepts handles decorated with @ and different casing', async () => {
    const rows = passingRows();
    rows[0]![0] = '@DEV-1';
    writeCsv(rows);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, HANDLES).passed).toBe(true);
    expect(byName(results, ROWS).passed).toBe(true);
  });

  it('fails the name assertion on a name that contradicts the profile', async () => {
    const rows = passingRows();
    rows[0]![1] = 'A Completely Different Person';
    writeCsv(rows);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, NAMES).passed).toBe(false);
    expect(byName(results, NAMES).detail).toMatch(/dev-1/);
    expect(byName(results, HANDLES).passed).toBe(true);
  });

  it('does not fail the name assertion for empty cells or nameless profiles', async () => {
    const rows = passingRows();
    rows[0]![1] = ''; // agent found no name — no answer, not a wrong answer
    rows[2]![1] = 'Whatever The Agent Found'; // oracle has no name for dev-3
    writeCsv(rows);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, NAMES).passed).toBe(true);
  });

  it('fails the linkedin assertion on a non-linkedin URL, tolerating empty-ish cells', async () => {
    const rows = passingRows();
    rows[0]![2] = 'n/a';
    rows[1]![2] = '';
    rows[2]![2] = 'https://twitter.com/dev-3';
    writeCsv(rows);

    const results = await grade(runDir, ORACLE);

    expect(byName(results, LINKEDIN).passed).toBe(false);
    expect(byName(results, LINKEDIN).detail).toMatch(/twitter/);
    expect(byName(results, NAMES).passed).toBe(true);
  });

  it('fails every content assertion, with detail, when no CSV exists', async () => {
    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'CSV artifact exists').passed).toBe(false);
    for (const r of results) {
      if (r.name === 'manifest hashes verify') continue;
      expect(r.passed).toBe(false);
      expect(r.detail).not.toBe('');
    }
  });

  it('throws on malformed oracle data — a harness bug, not a failed trial', async () => {
    writeCsv(passingRows());
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
