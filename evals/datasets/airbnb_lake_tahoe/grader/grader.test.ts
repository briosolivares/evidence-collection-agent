import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { AirbnbLakeTahoeOracle } from '../oracle/oracle.js';
import { grade, parseNumberedSections } from './grader.js';
import { byName } from '../../../testSupport.js';

const ORACLE: AirbnbLakeTahoeOracle = {
  locationTerms: ['lake tahoe', 'tahoe'],
  listingCount: 30,
  stayNights: 7,
  earliestCheckInDaysAfterRun: 1,
  latestCheckInDaysAfterRun: 14,
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'airbnb-grader-'));
  initManifest(runDir, 'airbnb grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function passingAnswer(): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 5);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  const items = Array.from(
    { length: 30 },
    (_, index) =>
      `${index + 1}. Tahoe Retreat ${index + 1}\nhttps://www.airbnb.com/rooms/${1000 + index}\n` +
      `A distinct mountain property with a kitchen, two bedrooms, parking, and convenient access to Lake Tahoe activities.`,
  ).join('\n\n');
  return `# Lake Tahoe options\n\nCheck-in: ${start.toISOString().slice(0, 10)}\nCheck-out: ${end.toISOString().slice(0, 10)}\n\n${items}\n\n## Overall Summary\n${'The set spans cabins and condos with varied amenities, locations, and tradeoffs for a week near the lake. '.repeat(2)}`;
}

describe('airbnb_lake_tahoe grader', () => {
  it('parses numbered Markdown headings and list items', () => {
    expect(
      parseNumberedSections('### 1. A\ntext\n\n2) B\ntext').map((item) => item.number),
    ).toEqual([1, 2]);
  });

  it('passes a complete, internally consistent report', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(passingAnswer()), {
      roles: ['requested_output'],
    });
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects a missing item and a duplicated room URL', async () => {
    const bad = passingAnswer()
      .replace(/^30\. [\s\S]*?(?=\n\n## Overall Summary)/m, '')
      .replace('/rooms/1001', '/rooms/1000');
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(bad), { roles: ['requested_output'] });
    const results = await grade(runDir, ORACLE);
    expect(
      byName(results, 'answer has a numbered list containing exactly items 1 through 30').passed,
    ).toBe(false);
    expect(byName(results, 'all 30 items contain distinct Airbnb room URLs').passed).toBe(false);
  });

  it('rejects a date range that is not next week and a thin overall summary', async () => {
    const bad = passingAnswer()
      .replace(/Check-in: \d{4}-\d{2}-\d{2}/, 'Check-in: 2001-01-01')
      .replace(/Check-out: \d{4}-\d{2}-\d{2}/, 'Check-out: 2001-01-08')
      .replace(/## Overall Summary[\s\S]*$/, '## Overall Summary\nToo short.');
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(bad), { roles: ['requested_output'] });
    const results = await grade(runDir, ORACLE);
    expect(
      byName(results, 'answer states a seven-night date range beginning next week').passed,
    ).toBe(false);
    expect(
      byName(results, 'answer contains a substantive overall summary and identifies Lake Tahoe')
        .passed,
    ).toBe(false);
  });

  it('requires manifested answer.md, verifies hashes, and validates the oracle', async () => {
    expect(
      byName(await grade(runDir, ORACLE), 'answer.md exists with a manifest entry').passed,
    ).toBe(false);
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(passingAnswer()), {
      roles: ['requested_output'],
    });
    writeFileSync(join(runDir, 'artifacts/answer.md'), `${passingAnswer()}\ntampered`);
    expect(byName(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
    await expect(async () => grade(runDir, { wrong: true })).rejects.toThrow(/oracle/);
  });
});
