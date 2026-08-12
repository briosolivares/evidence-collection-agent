import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import {
  createChecklistTask,
  getChecklistTask,
} from '../../run/checklist.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolDef } from '../registry.js';
import { taskUpdateTool } from './taskUpdate.js';

let runDir: string;
const registry = createRegistry([taskUpdateTool as ToolDef]);

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'task-update-test-'));
  initManifest(runDir, 'task update test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function call(input: unknown) {
  return executeToolCall(registry, { id: 'update-1', name: 'TaskUpdate', input }, { runDir });
}

function task() {
  return createChecklistTask(runDir, {
    subject: 'Old subject', description: 'Description', activeForm: 'Working',
    metadata: { keep: true, remove: 'yes' },
  });
}

describe('TaskUpdate', () => {
  it('requires a mutable field and validates strict input', async () => {
    for (const input of [{ taskId: '1' }, { taskId: '0', subject: 'x' }, { taskId: '1', extra: true }]) {
      const result = await call(input);
      expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    }
  });

  it('updates only named fields and merges metadata with null deletion', async () => {
    task();
    const result = await call({ taskId: '1', subject: 'New subject', metadata: { add: 42, remove: null } });
    expect(result).toMatchObject({ isError: false, content: 'Task #1 updated. Keep the checklist current as work proceeds.' });
    expect(getChecklistTask(runDir, '1')).toMatchObject({
      subject: 'New subject', description: 'Description', activeForm: 'Working',
      metadata: { keep: true, add: 42 },
    });
  });

  it('returns the exact completion nudge', async () => {
    task();
    const result = await call({ taskId: '1', status: 'completed' });
    // No expectedArtifacts metadata means completion is allowed.
    expect(result).toMatchObject({
      isError: false,
      content: 'Task #1 completed. Call TaskList now; do not batch task completions.',
    });
  });

  it('supports deleted as an action and removes the file', async () => {
    task();
    const result = await call({ taskId: '1', status: 'deleted' });
    expect(result).toMatchObject({ isError: false, content: 'Task #1 deleted.' });
    expect(getChecklistTask(runDir, '1')).toBeUndefined();
    expect(() => readFileSync(join(runDir, 'checklist', '1.json'))).toThrow();
  });

  it('reports missing deletion and missing update as execution errors', async () => {
    expect(await call({ taskId: '9', status: 'deleted' })).toMatchObject({
      isError: true, errorKind: 'execution_error',
    });
    expect(await call({ taskId: '9', status: 'pending' })).toMatchObject({
      isError: true, errorKind: 'execution_error',
    });
  });
});
