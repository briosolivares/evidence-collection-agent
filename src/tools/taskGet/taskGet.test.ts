import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import { createChecklistTask } from '../../run/checklist.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolDef } from '../registry.js';
import { taskGetTool } from './taskGet.js';

let runDir: string;
const registry = createRegistry([taskGetTool as ToolDef]);

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'task-get-test-'));
  initManifest(runDir, 'task get test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function call(input: unknown) {
  return executeToolCall(registry, { id: 'get-1', name: 'TaskGet', input }, { runDir });
}

describe('TaskGet', () => {
  it('returns the complete current task from the store', async () => {
    createChecklistTask(runDir, {
      subject: 'Collect evidence', description: 'Gather filing', activeForm: 'Collecting evidence',
      metadata: { source: 'SEC' },
    });
    const result = await call({ taskId: '1' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"activeForm": "Collecting evidence"');
    expect(JSON.parse(result.content)).toMatchObject({
      id: '1', subject: 'Collect evidence', description: 'Gather filing',
      status: 'pending', metadata: { source: 'SEC' },
    });
  });

  it('reports a missing task as a nonfatal result', async () => {
    await expect(call({ taskId: '99' })).resolves.toMatchObject({
      isError: false,
      content: 'Task #99 not found.',
    });
  });

  it('rejects strict or invalid input before the store is called', async () => {
    for (const input of [{ taskId: '0' }, { taskId: '1', extra: true }, {}]) {
      const result = await call(input);
      expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    }
  });
});
