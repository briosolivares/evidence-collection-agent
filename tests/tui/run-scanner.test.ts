import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRunSummary, scanRuns } from '../../src/tui/runScanner.js';
import { writeFixtureRun } from './runFixtures.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'sherlock-scan-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('scanRuns', () => {
  it('orders newest first and classifies every status', () => {
    writeFixtureRun(baseDir, {
      id: '2026-08-10T08-00-00-000Z-aaa',
      task: 'oldest, completed normally',
      startedAt: '2026-08-10T08:00:00.000Z',
      finishedAt: '2026-08-10T08:01:00.000Z',
      metrics: { status: 'completed', turns: 3, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, wallClockMs: 60_000 },
    });
    writeFixtureRun(baseDir, {
      id: '2026-08-11T09-00-00-000Z-bbb',
      task: 'terminal projection interrupted before manifest finalization',
      startedAt: '2026-08-11T09:00:00.000Z',
      metrics: { status: 'verified', turns: 3, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, wallClockMs: 60_000 },
    });
    writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-ccc',
      task: 'cancelled by Esc — finalized manifest, no metrics',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:00:18.000Z',
    });

    const entries = scanRuns(baseDir);
    expect(entries.map((entry) => entry.id)).toEqual([
      '2026-08-11T10-00-00-000Z-ccc',
      '2026-08-11T09-00-00-000Z-bbb',
      '2026-08-10T08-00-00-000Z-aaa',
    ]);
    expect(entries.map((entry) => entry.status)).toEqual([
      'stopped',
      'unfinished',
      'complete',
    ]);
  });

  it('never labels a cancelled run "crashed"', () => {
    writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-ccc',
      task: 'cancelled run',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:00:18.000Z',
    });
    const [entry] = scanRuns(baseDir);
    expect(entry?.status).toBe('stopped');
    expect(JSON.stringify(entry)).not.toContain('crash');
  });

  it.each([
    ['completed', 'complete'],
    ['verified', 'complete'],
    ['incomplete', 'stopped'],
    ['cancelled', 'stopped'],
    ['failed', 'stopped'],
    ['budget_exceeded', 'stopped'],
  ] as const)('classifies finalized metrics status %s as %s', (metricsStatus, expected) => {
    writeFixtureRun(baseDir, {
      id: `2026-08-11T10-00-00-000Z-${metricsStatus}`,
      task: `${metricsStatus} run`,
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:00:18.000Z',
      metrics: { status: metricsStatus, turns: 3, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, wallClockMs: 18_000 },
    });

    expect(scanRuns(baseDir)[0]?.status).toBe(expected);
  });

  it('skips non-run directories and junk files', () => {
    mkdirSync(join(baseDir, 'not-a-run'));
    writeFileSync(join(baseDir, '.DS_Store'), 'junk');
    writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-real',
      task: 'a real run',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:00:18.000Z',
    });
    const entries = scanRuns(baseDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.task).toBe('a real run');
  });

  it('returns empty for a missing runs directory', () => {
    expect(scanRuns(join(baseDir, 'nope'))).toEqual([]);
  });
});

describe('loadRunSummary', () => {
  it('builds the manifest view with sizes and sha256 prefixes, plus metrics', () => {
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-full',
      task: 'summarize me',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:01:24.000Z',
      metrics: { status: 'completed', turns: 5, inputTokens: 30_000, outputTokens: 1_200, cacheReadInputTokens: 9_000, wallClockMs: 84_000 },
      artifacts: [
        {
          filename: 'top5.csv',
          content: 'a,b,c\n1,2,3\n',
          sha256: 'deadbeefcafe0123456789abcdef',
          sourceUrl: 'https://news.ycombinator.com/',
          roles: ['requested_output'],
        },
      ],
    });

    const summary = loadRunSummary(runDir);
    expect(summary.manifest.task).toBe('summarize me');
    expect(summary.manifest.artifacts).toEqual([
      {
        filename: 'top5.csv',
        sizeBytes: 12,
        sha256Prefix: 'deadbeefcafe',
        sourceUrl: 'https://news.ycombinator.com/',
      },
    ]);
    expect(summary.metrics).toEqual({
      status: 'completed',
      turns: 5,
      totalTokens: 31_200,
      wallClockMs: 84_000,
    });
  });

  it('omits metrics for stopped runs', () => {
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-stop',
      task: 'stopped run',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:00:18.000Z',
    });
    expect(loadRunSummary(runDir).metrics).toBeUndefined();
  });
});

// --- legacy and current run directories must both stay readable ---------------

describe('run-directory compatibility across the cutover', () => {
  it('reads a legacy run directory unchanged', () => {
    // The historical shape: no roles beyond requested_output, no
    // completionStatus, no per-role metrics, status 'completed'.
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-01T10-00-00-000Z-legacy',
      task: 'a legacy run',
      startedAt: '2026-08-01T10:00:00.000Z',
      finishedAt: '2026-08-01T10:02:00.000Z',
      metrics: {
        status: 'completed',
        turns: 4,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        wallClockMs: 120_000,
      },
      artifacts: [
        {
          filename: 'out.csv',
          content: 'a\n1\n',
          sha256: 'aaaa1111',
          roles: ['requested_output'],
        },
      ],
    });

    const summary = loadRunSummary(runDir);
    expect(summary.metrics?.status).toBe('completed');
    expect(summary.manifest.artifacts).toHaveLength(1);
  });

  it('reads a current verified run, including per-role metrics it does not model', () => {
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-13T10-00-00-000Z-verified',
      task: 'a current run',
      startedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:03:00.000Z',
      metrics: {
        status: 'verified',
        turns: 6,
        inputTokens: 2_000,
        outputTokens: 300,
        cacheReadInputTokens: 5_000,
        wallClockMs: 180_000,
        // The reader must tolerate fields it knows nothing about.
        roles: {
          worker: { turns: 4, inputTokens: 1_500, outputTokens: 250, wallClockMs: 150_000 },
          verifier: { turns: 2, inputTokens: 500, outputTokens: 50, wallClockMs: 30_000 },
        },
      } as never,
      artifacts: [
        {
          filename: 'roster.csv',
          content: 'name\nAlpha\n',
          sha256: 'bbbb2222',
          roles: ['requested_output'],
        },
      ],
    });

    const summary = loadRunSummary(runDir);
    expect(summary.metrics?.status).toBe('verified');
    expect(summary.metrics?.turns).toBe(6);
  });

  it('reads a current incomplete run and keeps its partial output visible', () => {
    // The truthfulness guarantee at the reader boundary: an unverified run is
    // still listed, with its artifacts, and its status says so.
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-13T11-00-00-000Z-incomplete',
      task: 'a current run that did not verify',
      startedAt: '2026-08-13T11:00:00.000Z',
      finishedAt: '2026-08-13T11:04:00.000Z',
      metrics: {
        status: 'incomplete',
        turns: 9,
        inputTokens: 3_000,
        outputTokens: 400,
        cacheReadInputTokens: 7_000,
        wallClockMs: 240_000,
      },
      artifacts: [
        {
          filename: 'roster.csv',
          content: 'name\nAlpha\n',
          sha256: 'cccc3333',
          roles: ['requested_output'],
          completionStatus: 'partial',
        } as never,
      ],
    });

    const summary = loadRunSummary(runDir);
    expect(summary.metrics?.status).toBe('incomplete');
    // The partial deliverable is still surfaced rather than hidden.
    expect(summary.manifest.artifacts[0]?.filename).toBe('roster.csv');
  });

  it('lists legacy and current runs side by side', () => {
    // A runs/ directory accumulated across the cutover holds both shapes; the
    // browser must list them together rather than choking on either.
    const metrics = (status: string) => ({
      status,
      turns: 3,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      wallClockMs: 1_000,
    });
    for (const [id, status] of [
      ['2026-08-01T10-00-00-000Z-legacy', 'completed'],
      ['2026-08-13T10-00-00-000Z-verified', 'verified'],
      ['2026-08-13T11-00-00-000Z-incomplete', 'incomplete'],
    ] as const) {
      writeFixtureRun(baseDir, {
        id,
        task: id,
        startedAt: '2026-08-13T10:00:00.000Z',
        finishedAt: '2026-08-13T10:01:00.000Z',
        metrics: metrics(status) as never,
        artifacts: [],
      });
    }

    const ids = scanRuns(baseDir).map((entry) => entry.id);
    expect(ids).toContain('2026-08-01T10-00-00-000Z-legacy');
    expect(ids).toContain('2026-08-13T10-00-00-000Z-verified');
    expect(ids).toContain('2026-08-13T11-00-00-000Z-incomplete');
  });
});
