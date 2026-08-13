import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { METRICS_FILENAME, type RunMetrics } from '../loop/agentLoop.js';
import {
  archiveCycleMetrics,
  HARNESS_FILENAME,
  rollupCycleMetrics,
  writeHarnessDiagnostics,
  writeMetricsRollup,
  type HarnessDiagnostics,
} from './harness.js';

// Every helper here is pure I/O or pure arithmetic over a temp run
// directory — no model calls, no browser, matching the hermetic-suite
// convention used across this codebase's other run-dir helpers
// (artifacts.test.ts, transcript.test.ts).

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'harness-test-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    status: 'completed',
    turns: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    peakContextTokens: 15,
    wallClockMs: 100,
    ...overrides,
  };
}

describe('writeHarnessDiagnostics', () => {
  it('writes harness.json with the given diagnostics, pretty-printed', () => {
    const diagnostics: HarnessDiagnostics = {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [
        { cycle: 1, workerStatus: 'completed', verdict: 'done' },
      ],
    };

    writeHarnessDiagnostics(runDir, diagnostics);

    const path = join(runDir, HARNESS_FILENAME);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(diagnostics);
  });

  it('overwrites a previous harness.json rather than appending', () => {
    writeHarnessDiagnostics(runDir, {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [{ cycle: 1, workerStatus: 'budget_exceeded' }],
    });
    const second: HarnessDiagnostics = {
      initializer: { model: 'claude-sonnet-5' },
      cycles: [
        { cycle: 1, workerStatus: 'completed', verdict: 'continue', reason: 'missing a column' },
        { cycle: 2, workerStatus: 'completed', verdict: 'done' },
      ],
    };

    writeHarnessDiagnostics(runDir, second);

    expect(JSON.parse(readFileSync(join(runDir, HARNESS_FILENAME), 'utf8'))).toEqual(second);
  });
});

describe('archiveCycleMetrics', () => {
  it('renames metrics.json to metrics-cycle-<N>.json and returns its parsed contents', () => {
    const written = metrics({ turns: 4, inputTokens: 40 });
    writeFileSync(join(runDir, METRICS_FILENAME), JSON.stringify(written));

    const result = archiveCycleMetrics(runDir, 1);

    expect(result).toEqual(written);
    expect(existsSync(join(runDir, METRICS_FILENAME))).toBe(false);
    expect(existsSync(join(runDir, 'metrics-cycle-1.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir, 'metrics-cycle-1.json'), 'utf8'))).toEqual(written);
  });

  it('names successive cycles distinctly, leaving earlier archives untouched', () => {
    writeFileSync(join(runDir, METRICS_FILENAME), JSON.stringify(metrics({ turns: 1 })));
    archiveCycleMetrics(runDir, 1);
    writeFileSync(join(runDir, METRICS_FILENAME), JSON.stringify(metrics({ turns: 2 })));
    archiveCycleMetrics(runDir, 2);

    expect(
      JSON.parse(readFileSync(join(runDir, 'metrics-cycle-1.json'), 'utf8')),
    ).toMatchObject({ turns: 1 });
    expect(
      JSON.parse(readFileSync(join(runDir, 'metrics-cycle-2.json'), 'utf8')),
    ).toMatchObject({ turns: 2 });
  });

  it('throws when metrics.json is missing', () => {
    expect(() => archiveCycleMetrics(runDir, 1)).toThrow();
  });
});

describe('rollupCycleMetrics', () => {
  it('sums turns and token counters, maxes peakContextTokens, sums wallClockMs, across cycles', () => {
    const cycle1 = metrics({
      turns: 3,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      peakContextTokens: 20,
      wallClockMs: 100,
    });
    const cycle2 = metrics({
      turns: 5,
      inputTokens: 30,
      outputTokens: 6,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 0,
      peakContextTokens: 55,
      wallClockMs: 250,
    });

    const rollup = rollupCycleMetrics('completed', [cycle1, cycle2]);

    expect(rollup).toEqual({
      status: 'completed',
      turns: 8,
      inputTokens: 40,
      outputTokens: 10,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 1,
      peakContextTokens: 55,
      wallClockMs: 350,
    });
  });

  it('reports the given status regardless of the per-cycle statuses folded in', () => {
    const rollup = rollupCycleMetrics('budget_exceeded', [
      metrics({ status: 'completed' }),
      metrics({ status: 'budget_exceeded' }),
    ]);
    expect(rollup.status).toBe('budget_exceeded');
  });

  it('returns all-zero totals for zero cycles', () => {
    expect(rollupCycleMetrics('completed', [])).toEqual({
      status: 'completed',
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      peakContextTokens: 0,
      wallClockMs: 0,
    });
  });
});

describe('writeMetricsRollup', () => {
  it('writes metrics.json with the given RunMetrics, pretty-printed', () => {
    const rollup = metrics({ turns: 9 });
    writeMetricsRollup(runDir, rollup);

    const path = join(runDir, METRICS_FILENAME);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(rollup);
  });
});
