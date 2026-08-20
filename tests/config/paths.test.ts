import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadFirstEnvFile, resolveSherlockPaths } from '../../src/config/paths.js';

describe('resolveSherlockPaths', () => {
  it('anchors everything to ~/.sherlock when installed (no devRoot)', () => {
    const paths = resolveSherlockPaths({
      env: {},
      home: '/home/u',
      cwd: '/somewhere/else',
    });
    expect(paths.dataHome).toBe('/home/u/.sherlock');
    expect(paths.profileDir).toBe('/home/u/.sherlock/chrome-profile');
    expect(paths.runsBaseDir).toBe('/home/u/.sherlock/runs');
    expect(paths.evalsDir).toBe('/home/u/.sherlock/evals/datasets');
    expect(paths.evalResultsDir).toBe('/home/u/.sherlock/runs/eval-results');
    expect(paths.envFileCandidates).toEqual(['/somewhere/else/.env', '/home/u/.sherlock/.env']);
  });

  it('keeps a dev checkout repo-anchored, regardless of cwd', () => {
    const paths = resolveSherlockPaths({
      env: {},
      devRoot: '/repo',
      home: '/home/u',
      cwd: '/somewhere/else',
    });
    expect(paths.profileDir).toBe('/repo/chrome-profile');
    expect(paths.runsBaseDir).toBe('/repo/runs');
    expect(paths.evalsDir).toBe('/repo/evals/datasets');
    expect(paths.evalResultsDir).toBe('/repo/runs/eval-results');
    expect(paths.envFileCandidates).toEqual(['/repo/.env']);
  });

  it('SHERLOCK_HOME overrides the data home, even in a checkout', () => {
    const paths = resolveSherlockPaths({
      env: { SHERLOCK_HOME: '/custom' },
      devRoot: '/repo',
      home: '/home/u',
      cwd: '/somewhere/else',
    });
    expect(paths.dataHome).toBe('/custom');
    expect(paths.profileDir).toBe('/custom/chrome-profile');
    expect(paths.runsBaseDir).toBe('/custom/runs');
    expect(paths.envFileCandidates).toEqual(['/somewhere/else/.env', '/custom/.env']);
  });

  it('SHERLOCK_RUNS_DIR moves only the runs base; results follow it', () => {
    const paths = resolveSherlockPaths({
      env: { SHERLOCK_RUNS_DIR: '/evidence' },
      home: '/home/u',
      cwd: '/somewhere/else',
    });
    expect(paths.runsBaseDir).toBe('/evidence');
    expect(paths.evalResultsDir).toBe('/evidence/eval-results');
    expect(paths.profileDir).toBe('/home/u/.sherlock/chrome-profile');
  });

  it('resolves a relative SHERLOCK_RUNS_DIR against the cwd', () => {
    const paths = resolveSherlockPaths({
      env: { SHERLOCK_RUNS_DIR: 'my-runs' },
      home: '/home/u',
      cwd: '/work',
    });
    expect(paths.runsBaseDir).toBe('/work/my-runs');
  });
});

describe('loadFirstEnvFile', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.SHERLOCK_PATHS_TEST_VAR;
  });

  it('loads the first candidate that exists and reports which', () => {
    dir = mkdtempSync(join(tmpdir(), 'sherlock-paths-'));
    const present = join(dir, 'present.env');
    writeFileSync(present, 'SHERLOCK_PATHS_TEST_VAR=loaded\n');
    const loaded = loadFirstEnvFile([join(dir, 'absent.env'), present]);
    expect(loaded).toBe(present);
    expect(process.env.SHERLOCK_PATHS_TEST_VAR).toBe('loaded');
  });

  it('returns undefined when no candidate exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'sherlock-paths-'));
    expect(loadFirstEnvFile([join(dir, 'absent.env')])).toBeUndefined();
  });
});
