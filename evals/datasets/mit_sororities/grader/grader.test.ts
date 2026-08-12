import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import { MIT_SORORITIES, type MitSororitiesOracle } from '../oracle/oracle.js';
import { grade } from './grader.js';

const ORACLE: MitSororitiesOracle = {
  affiliations: MIT_SORORITIES, classes: [2026, 2027], minRows: 12, maxRows: 400,
  minMajorCoverage: 0.5, minEnrichmentCoverage: 0.25,
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'mit-sororities-grader-'));
  initManifest(runDir, 'sorority grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function passingCsv(): string {
  const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  const classWords = ['Senior', 'Junior'];
  const rows = MIT_SORORITIES.flatMap((affiliation, i) => [2026, 2027].map((year, j) =>
    [`Member${words[i]} Person${classWords[j]}`, year, 'Computer Science', affiliation, 'Robotics and music', 'Chapter leader'].join(','),
  ));
  return `name,class,major,affiliation,interests,other\n${rows.join('\n')}\n`;
}
function writePassingArtifacts(): void {
  writeArtifact(runDir, 'sorority_members.csv', Buffer.from(passingCsv()));
  writeArtifact(runDir, 'answer.md', Buffer.from('Sheet: https://docs.google.com/spreadsheets/d/abc_123/edit#gid=0\n'));
}
function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`missing assertion ${name}`);
  return found;
}

describe('mit_sororities grader', () => {
  it('passes a local evidence copy covering all twelve cohorts plus a Sheet URL', async () => {
    writePassingArtifacts();
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects an extra CSV column and a missing cohort', async () => {
    const bad = passingCsv().replace('name,class,major,affiliation,interests,other', 'name,class,major,affiliation,interests,other,source')
      .split('\n').filter((line) => !line.includes('Alpha Chi Omega') || !line.includes(',2027,')).join('\n');
    writeArtifact(runDir, 'sorority_members.csv', Buffer.from(bad));
    writeArtifact(runDir, 'answer.md', Buffer.from('https://docs.google.com/spreadsheets/d/sheet-id/edit'));
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'CSV has exactly the columns name, class, major, affiliation, interests, other (no more, no fewer)').passed).toBe(false);
    expect(byName(results, 'CSV has plausible rows and every sorority/class cohort is represented').passed).toBe(false);
  });

  it('rejects duplicate members, poor information coverage, and a non-Sheets URL', async () => {
    const lines = passingCsv().trim().split('\n');
    const sparse = lines.map((line, index) => {
      if (index === 0) return line;
      const cells = line.split(',');
      cells[2] = '';
      cells[4] = '';
      cells[5] = '';
      return cells.join(',');
    }).join('\n');
    writeArtifact(runDir, 'sorority_members.csv', Buffer.from(`${sparse}\n${lines[1]}\n`));
    writeArtifact(runDir, 'answer.md', Buffer.from('https://docs.google.com/document/d/not-a-sheet'));
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'member names are plausible and unique within each affiliation').passed).toBe(false);
    expect(byName(results, 'major and interests/other fields meet minimum information coverage').passed).toBe(false);
    expect(byName(results, 'answer.md contains a plausible Google Sheets URL').passed).toBe(false);
  });

  it('requires the named artifacts, catches tampering, and rejects malformed oracle data', async () => {
    expect(byName(await grade(runDir, ORACLE), 'sorority_members.csv exists with a manifest entry').passed).toBe(false);
    writePassingArtifacts();
    writeFileSync(join(runDir, 'sorority_members.csv'), `${passingCsv()}tampered`);
    expect(byName(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
    await expect(async () => grade(runDir, { nope: true })).rejects.toThrow(/oracle/);
  });
});
