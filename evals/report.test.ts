import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { summarizeTask } from './metrics.js';
import { formatReport, writeResults } from './report.js';
import type { EvalReport } from './runner.js';

/** A hand-built report: trial 1 clean, trial 2 with a hash failure → accuracy 75%. */
function sampleReport(): EvalReport {
  return {
    startedAt: '2026-08-10T00:00:00.000Z',
    finishedAt: '2026-08-10T00:00:05.000Z',
    k: 2,
    tasks: [
      summarizeTask('stub', [
        {
          runDir: '/runs/r1',
          assertions: [
            { name: 'answer.md exists', passed: true, detail: 'found' },
            { name: 'hash verifies', passed: true, detail: 'match' },
          ],
          latencyMs: 40,
        },
        {
          runDir: '/runs/r2',
          assertions: [
            { name: 'answer.md exists', passed: true, detail: 'found' },
            { name: 'hash verifies', passed: false, detail: 'sha256 mismatch on disk' },
          ],
          latencyMs: 60,
        },
      ]),
    ],
  };
}

describe('formatReport', () => {
  it('renders aggregate metrics, per-trial lines, and detail for failed assertions', () => {
    const text = formatReport(sampleReport());

    expect(text).toContain('k=2');
    expect(text).toContain('stub: accuracy 75.0%  completion 1/2  task FAIL  mean latency 50ms');
    expect(text).toContain('trial 1: 2/2 assertions');
    expect(text).toContain('trial 2: 1/2 assertions');
    expect(text).toContain('/runs/r2');
    // Failed assertions surface their detail; passing ones just their name.
    expect(text).toContain('FAIL  hash verifies — sha256 mismatch on disk');
    expect(text).toContain('pass  answer.md exists');
    expect(text).toContain('0/1 tasks passed');
  });
});

describe('writeResults', () => {
  let resultsDir: string;

  beforeEach(() => {
    resultsDir = mkdtempSync(join(tmpdir(), 'eval-results-test-'));
  });

  afterEach(() => {
    rmSync(resultsDir, { recursive: true, force: true });
  });

  it('writes JSON that parses back to a deep-equal copy of the report', () => {
    const report = sampleReport();

    const path = writeResults(report, resultsDir);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
  });

  it('never overwrites: two writes of the same report land in two files', () => {
    const report = sampleReport();

    const first = writeResults(report, resultsDir);
    const second = writeResults(report, resultsDir);

    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual(report);
  });
});
