import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DATASETS_DIR } from '../config.js';
import { loadEvalTask } from './loadTask.js';

// The real datasets directory from config — the stub task doubles as the
// loader's fixture.
const evalsDir = DATASETS_DIR;

describe('loadEvalTask', () => {
  it('loads the stub task: task.json fields plus working grader and oracle', async () => {
    const task = await loadEvalTask(evalsDir, 'stub');

    expect(task.name).toBe('stub');
    expect(task.taskText).toContain('answer.md');
    expect(task.startUrl).toBe('about:blank');
    expect(task.headed).toBe(false);
    expect(typeof task.grade).toBe('function');
    await expect(task.fetchOracle()).resolves.toEqual({ expectedFile: 'artifacts/answer.md' });
  });

  it('rejects non-boolean headed-lane metadata', async () => {
    const tmpEvals = mkdtempSync(join(tmpdir(), 'load-task-headed-test-'));
    try {
      mkdirSync(join(tmpEvals, 'bad'));
      writeFileSync(
        join(tmpEvals, 'bad', 'task.json'),
        '{"task":"bad lane metadata","headed":"yes"}',
      );

      await expect(loadEvalTask(tmpEvals, 'bad')).rejects.toThrow(/headed.*boolean/);
    } finally {
      rmSync(tmpEvals, { recursive: true, force: true });
    }
  });

  it('reads explicit headed-lane and required-session metadata, never inferring from task text', async () => {
    await expect(loadEvalTask(evalsDir, 'mit_sororities')).resolves.toMatchObject({
      headed: true,
      requiresLogin: ['google-sheets'],
    });
    await expect(loadEvalTask(evalsDir, 'elon_tweets')).resolves.toMatchObject({
      headed: true,
      requiresLogin: ['x'],
    });
    // edgar is headed to dodge bot-blocking, not for a session: the two
    // properties are independent and the loader must not conflate them.
    await expect(loadEvalTask(evalsDir, 'edgar')).resolves.toMatchObject({
      headed: true,
      requiresLogin: [],
    });
    await expect(loadEvalTask(evalsDir, 'stub')).resolves.toMatchObject({ requiresLogin: [] });
  });

  it('rejects an unknown or malformed login requirement at load time', async () => {
    const tmpEvals = mkdtempSync(join(tmpdir(), 'load-task-login-test-'));
    try {
      mkdirSync(join(tmpEvals, 'typo'));
      writeFileSync(
        join(tmpEvals, 'typo', 'task.json'),
        '{"task":"typo","requiresLogin":["gogle-sheets"]}',
      );
      await expect(loadEvalTask(tmpEvals, 'typo')).rejects.toThrow(/unknown login service/);

      mkdirSync(join(tmpEvals, 'shape'));
      writeFileSync(
        join(tmpEvals, 'shape', 'task.json'),
        '{"task":"shape","requiresLogin":"google-sheets"}',
      );
      await expect(loadEvalTask(tmpEvals, 'shape')).rejects.toThrow(/must be an array/);
    } finally {
      rmSync(tmpEvals, { recursive: true, force: true });
    }
  });

  it('rejects the retired "requiresAuth" field instead of dropping the task to headless', async () => {
    const tmpEvals = mkdtempSync(join(tmpdir(), 'load-task-legacy-test-'));
    try {
      mkdirSync(join(tmpEvals, 'stale'));
      writeFileSync(
        join(tmpEvals, 'stale', 'task.json'),
        '{"task":"legacy lane metadata","requiresAuth":true}',
      );

      await expect(loadEvalTask(tmpEvals, 'stale')).rejects.toThrow(/renamed to "headed"/);
    } finally {
      rmSync(tmpEvals, { recursive: true, force: true });
    }
  });

  it('rejects task names that could traverse outside the evals dir', async () => {
    await expect(loadEvalTask(evalsDir, '../stub')).rejects.toThrow(/task name/);
    await expect(loadEvalTask(evalsDir, 'a/b')).rejects.toThrow(/task name/);
    await expect(loadEvalTask(evalsDir, '')).rejects.toThrow(/task name/);
  });

  it('names the task in the error when its directory is missing', async () => {
    await expect(loadEvalTask(evalsDir, 'no_such_task')).rejects.toThrow(/no_such_task/);
  });

  it('rejects a task.json without a non-empty "task" field', async () => {
    const tmpEvals = mkdtempSync(join(tmpdir(), 'load-task-test-'));
    try {
      mkdirSync(join(tmpEvals, 'bad'));
      writeFileSync(join(tmpEvals, 'bad', 'task.json'), '{"startUrl": "about:blank"}');

      await expect(loadEvalTask(tmpEvals, 'bad')).rejects.toThrow(/"task"/);
    } finally {
      rmSync(tmpEvals, { recursive: true, force: true });
    }
  });
});
