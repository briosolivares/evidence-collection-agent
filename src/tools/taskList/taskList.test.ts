import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import { createChecklistTask, updateChecklistTask } from '../../run/checklist.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { taskListTool } from './taskList.js';

let runDir: string;
const registry = createRegistry([taskListTool]);

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'task-list-tool-'));
  initManifest(runDir, 'test task');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function call(input: unknown) {
  return executeToolCall(registry, { id: 'call-task-list', name: 'TaskList', input }, { runDir });
}

describe('TaskList', () => {
  it('returns the empty-list result', async () => {
    await expect(call({})).resolves.toMatchObject({
      isError: false,
      content: 'No checklist tasks found',
    });
  });

  it('returns compact numerically sorted task lines and reflects current status', async () => {
    const first = createChecklistTask(runDir, { subject: 'First', description: 'One' });
    const second = createChecklistTask(runDir, { subject: 'Second', description: 'Two' });
    updateChecklistTask(runDir, second.id, { status: 'in_progress' });
    updateChecklistTask(runDir, first.id, { status: 'completed' });

    const result = await call({});
    expect(result).toMatchObject({
      isError: false,
      content: '#1 [completed] First\n#2 [in_progress] Second',
    });
    expect(taskListTool.readOnly).toBe(true);
  });

  it('rejects non-empty input because the schema is strict and empty', async () => {
    const result = await call({ taskId: '1' });
    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(result.content).toContain('taskId');
  });

  it('surfaces malformed checklist state as a structured execution error', async () => {
    createChecklistTask(runDir, { subject: 'Valid', description: 'Task' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(runDir, 'checklist', '1.json'), '{broken');
    const result = await call({});
    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('1.json');
  });
});
