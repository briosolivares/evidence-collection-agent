import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { ElonTweetsOracle } from '../oracle/oracle.js';
import { grade } from './grader.js';

const ORACLE: ElonTweetsOracle = {
  accountHandle: 'elonmusk', minRows: 1, maxRows: 200,
  acceptedTimeZones: ['America/Los_Angeles', 'UTC'],
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'elon-tweets-grader-'));
  initManifest(runDir, 'tweet grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function writeCsv(body = 'text,likes,time_posted\nFirst tweet,"1,234",9:15 AM\nSecond tweet,2.5K,2h ago\n'): void {
  writeArtifact(runDir, 'artifacts/tweets.csv', Buffer.from(body), { roles: ['requested_output'] });
}
function assertion(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`missing assertion ${name}`);
  return found;
}

describe('elon_tweets grader', () => {
  it('passes a structurally consistent same-day CSV', async () => {
    writeCsv();
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects duplicate text, a negative like count, and an old date independently', async () => {
    writeCsv('text,likes,time_posted\nSame,-2,2001-01-01T10:00:00Z\nSame,4,10:30 AM\n');
    const results = await grade(runDir, ORACLE);
    expect(assertion(results, 'every text cell is non-empty and tweet texts are distinct').passed).toBe(false);
    expect(assertion(results, 'every likes cell is a non-negative integer or compact X count').passed).toBe(false);
    expect(assertion(results, "every time_posted cell is a plausible time from the run's day").passed).toBe(false);
  });

  it('enforces the exact three-column schema', async () => {
    writeCsv('text,likes,time_posted,url\nA,1,now,https://x.com/elonmusk/status/1\n');
    const results = await grade(runDir, ORACLE);
    expect(assertion(results, 'CSV has exactly the columns text, likes, time_posted (no more, no fewer)').passed).toBe(false);
  });

  it('fails content assertions when the CSV is absent and detects tampering', async () => {
    const missing = await grade(runDir, ORACLE);
    expect(assertion(missing, 'CSV artifact exists').passed).toBe(false);
    writeCsv();
    writeFileSync(join(runDir, 'artifacts', 'tweets.csv'), 'text,likes,time_posted\nChanged,1,now\n');
    expect(assertion(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
  });

  it('throws on malformed oracle data', async () => {
    writeCsv();
    await expect(async () => grade(runDir, { wrong: true })).rejects.toThrow(/oracle/);
  });
});
