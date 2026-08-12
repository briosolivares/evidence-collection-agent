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
    expect(typeof task.grade).toBe('function');
    await expect(task.fetchOracle()).resolves.toEqual({ expectedFile: 'artifacts/answer.md' });
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
