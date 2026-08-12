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
      task: 'still in flight (or crashed) — no finishedAt',
      startedAt: '2026-08-11T09:00:00.000Z',
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
  it('includes published artifacts and excludes scratch and checklist entries', () => {
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-partitioned',
      task: 'partitioned run',
      startedAt: '2026-08-11T10:00:00.000Z',
    });
    mkdirSync(join(runDir, 'artifacts'));
    mkdirSync(join(runDir, 'scratch'));
    mkdirSync(join(runDir, 'checklist'));
    writeFileSync(join(runDir, 'artifacts', 'answer.csv'), 'answer');
    writeFileSync(join(runDir, 'scratch', 'notes.txt'), 'private notes');
    writeFileSync(join(runDir, 'checklist', '1.json'), '{"id":"1"}');
    writeFileSync(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        task: 'partitioned run',
        startedAt: '2026-08-11T10:00:00.000Z',
        artifacts: [
          {
            filename: 'artifacts/answer.csv',
            sha256: 'published-sha',
            roles: ['requested_output'],
            capturedAt: '2026-08-11T10:00:00.000Z',
          },
          {
            filename: 'scratch/notes.txt',
            sha256: 'scratch-sha',
            capturedAt: '2026-08-11T10:00:00.000Z',
          },
          {
            filename: 'checklist/1.json',
            sha256: 'checklist-sha',
            capturedAt: '2026-08-11T10:00:00.000Z',
          },
        ],
      }),
    );

    expect(loadRunSummary(runDir).manifest.artifacts).toEqual([
      {
        filename: 'artifacts/answer.csv',
        sizeBytes: 6,
        sha256Prefix: 'published-sh',
      },
    ]);
  });

  it('builds the manifest view with sizes and sha256 prefixes, plus metrics', () => {
    const runDir = writeFixtureRun(baseDir, {
      id: '2026-08-11T10-00-00-000Z-full',
      task: 'summarize me',
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:01:24.000Z',
      metrics: { status: 'completed', turns: 5, inputTokens: 30_000, outputTokens: 1_200, cacheReadInputTokens: 9_000, wallClockMs: 84_000 },
      artifacts: [
        {
          filename: 'artifacts/top5.csv',
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
        filename: 'artifacts/top5.csv',
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
