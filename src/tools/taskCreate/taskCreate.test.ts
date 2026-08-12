import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { taskCreateTool } from './taskCreate.js';

let runDir: string;
const registry = createRegistry([taskCreateTool]);

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'task-create-tool-'));
  initManifest(runDir, 'test task');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function call(input: unknown) {
  return executeToolCall(registry, { id: 'call-task-create', name: 'TaskCreate', input }, { runDir });
}

describe('TaskCreate', () => {
  it('creates a pending task through the pipeline and returns the creation nudge', async () => {
    const result = await call({
      subject: 'Collect evidence',
      description: 'Gather the filing documents',
      activeForm: 'Collecting evidence',
      metadata: { expectedArtifacts: ['artifacts/evidence.csv'], source: 'filing' },
    });

    expect(result).toEqual({
      toolCallId: 'call-task-create',
      isError: false,
      content: 'Task #1 created: Collect evidence. Mark it in_progress before starting it.',
    });
    expect(JSON.parse(readFileSync(join(runDir, 'checklist', '1.json'), 'utf8'))).toEqual({
      id: '1',
      subject: 'Collect evidence',
      description: 'Gather the filing documents',
      status: 'pending',
      activeForm: 'Collecting evidence',
      metadata: { expectedArtifacts: ['artifacts/evidence.csv'], source: 'filing' },
    });
    expect(taskCreateTool.readOnly).toBe(false);
  });

  it('rejects missing and unknown input fields as structured invalid-input errors', async () => {
    const missing = await call({ description: 'No subject' });
    expect(missing).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(missing.content).toContain('subject');

    const extra = await call({ subject: 'x', description: 'y', unexpected: true });
    expect(extra).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(extra.content).toContain('unexpected');
  });
});
