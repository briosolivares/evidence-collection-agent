import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKLIST_DIR,
  initManifest,
  MANIFEST_FILENAME,
  writeArtifact,
  type Manifest,
} from './artifacts.js';
import {
  checklistTaskSchema,
  createChecklistTask,
  deleteChecklistTask,
  getChecklistTask,
  listChecklistTasks,
  onChecklistUpdated,
  updateChecklistTask,
} from './checklist.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'checklist-test-'));
  initManifest(runDir, 'checklist test');
});

afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

describe('checklist store', () => {
  it('uses a strict task schema and validates positive IDs and statuses', () => {
    expect(() => checklistTaskSchema.parse({
      id: '1', subject: 'A', description: 'B', status: 'pending', extra: true,
    })).toThrow();
    expect(() => checklistTaskSchema.parse({
      id: '0', subject: 'A', description: 'B', status: 'pending',
    })).toThrow();
    expect(() => checklistTaskSchema.parse({
      id: '1', subject: 'A', description: 'B', status: 'deleted',
    })).toThrow();
  });

  it('creates durable numeric IDs, pretty JSON, and manifest hashes', () => {
    const task = createChecklistTask(runDir, {
      subject: 'Collect evidence',
      description: 'Gather the requested filing',
      activeForm: 'Collecting evidence',
      metadata: { expectedArtifacts: ['artifacts/filing.csv'], source: 'SEC' },
    });

    expect(task.id).toBe('1');
    const path = join(runDir, CHECKLIST_DIR, '1.json');
    const bytes = readFileSync(path);
    expect(bytes.toString()).toBe(`${JSON.stringify(task, null, 2)}\n`);
    const entry = manifest().artifacts.find((item) => item.filename === 'checklist/1.json');
    expect(entry?.roles).toBeUndefined();
    expect(entry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    const second = createChecklistTask(runDir, { subject: 'Second', description: 'Another task' });
    expect(second.id).toBe('2');
    expect(readFileSync(join(runDir, CHECKLIST_DIR, '.highwatermark'), 'utf8')).toBe('2\n');
  });

  it('uses the highest existing ID when resuming from disk without a high-water mark', () => {
    writeArtifact(
      runDir,
      'checklist/7.json',
      Buffer.from(JSON.stringify({ id: '7', subject: 'Existing', description: 'Disk', status: 'pending' }) + '\n'),
      { managedState: 'checklist' },
    );
    expect(createChecklistTask(runDir, { subject: 'New', description: 'After resume' }).id).toBe('8');
  });

  it('lists in numeric order, gets tasks, and reconstructs state from disk', () => {
    for (const [id, subject] of [['10', 'ten'], ['2', 'two']]) {
      writeArtifact(
        runDir,
        `checklist/${id}.json`,
        Buffer.from(JSON.stringify({ id, subject, description: 'task', status: 'pending' }) + '\n'),
        { managedState: 'checklist' },
      );
    }
    expect(listChecklistTasks(runDir).map((task) => task.id)).toEqual(['2', '10']);
    expect(getChecklistTask(runDir, '2')?.subject).toBe('two');
    expect(getChecklistTask(runDir, '99')).toBeUndefined();
    expect(listChecklistTasks(runDir)).toEqual(listChecklistTasks(runDir));
  });

  it('partially updates fields and merges metadata, with null deleting keys', () => {
    const created = createChecklistTask(runDir, {
      subject: 'Old subject', description: 'Description', activeForm: 'Working',
      metadata: { keep: true, remove: 'yes' },
    });
    const updated = updateChecklistTask(runDir, created.id, {
      subject: 'New subject', metadata: { add: 42, remove: null },
    });
    expect(updated).toMatchObject({
      id: '1', subject: 'New subject', description: 'Description', activeForm: 'Working',
      metadata: { keep: true, add: 42 },
    });
    expect(updateChecklistTask(runDir, '1', { metadata: { keep: null, add: null } }).metadata)
      .toBeUndefined();
    expect(() => updateChecklistTask(runDir, '1', {})).toThrow(/must change/);
  });

  it('allows status corrections, reopening, and multiple in-progress tasks', () => {
    const one = createChecklistTask(runDir, { subject: 'One', description: 'One' });
    const two = createChecklistTask(runDir, { subject: 'Two', description: 'Two' });
    expect(updateChecklistTask(runDir, one.id, { status: 'in_progress' }).status).toBe('in_progress');
    expect(updateChecklistTask(runDir, two.id, { status: 'in_progress' }).status).toBe('in_progress');
    expect(updateChecklistTask(runDir, one.id, { status: 'completed' }).status).toBe('completed');
    expect(updateChecklistTask(runDir, one.id, { status: 'pending' }).status).toBe('pending');
  });

  it('requires expected requested outputs before completion and leaves failure unchanged', () => {
    const task = createChecklistTask(runDir, {
      subject: 'Publish', description: 'Publish report',
      metadata: { expectedArtifacts: ['artifacts/report.csv'] },
    });
    expect(() => updateChecklistTask(runDir, task.id, { status: 'completed' }))
      .toThrow(/promised artifact/);
    expect(getChecklistTask(runDir, task.id)?.status).toBe('pending');

    writeArtifact(runDir, 'artifacts/report.csv', Buffer.from('evidence only\n'), {
      roles: ['evidence'],
    });
    expect(() => updateChecklistTask(runDir, task.id, { status: 'completed' }))
      .toThrow(/requested_output/);
    expect(getChecklistTask(runDir, task.id)?.status).toBe('pending');

    writeArtifact(runDir, 'artifacts/report.csv', Buffer.from('report\n'), {
      roles: ['requested_output'],
    });
    expect(updateChecklistTask(runDir, task.id, { status: 'completed' }).status).toBe('completed');
  });

  it('rejects malformed JSON and schema files with their paths', () => {
    const malformed = join(runDir, CHECKLIST_DIR, '1.json');
    writeFileSync(malformed, '{not json');
    expect(() => getChecklistTask(runDir, '1')).toThrow(/checklist[\\/]1\.json/);

    writeFileSync(malformed, JSON.stringify({ id: '1', subject: 'x', description: 'y', status: 'pending', unknown: true }));
    expect(() => listChecklistTasks(runDir)).toThrow(/checklist[\\/]1\.json/);
  });

  it('deletes tasks without reusing IDs and reports missing get/update/delete cleanly', () => {
    const task = createChecklistTask(runDir, { subject: 'Delete me', description: 'Task' });
    expect(deleteChecklistTask(runDir, task.id)).toBe(true);
    expect(existsSync(join(runDir, CHECKLIST_DIR, '1.json'))).toBe(false);
    expect(manifest().artifacts.some((entry) => entry.filename === 'checklist/1.json')).toBe(false);
    expect(deleteChecklistTask(runDir, task.id)).toBe(false);
    expect(getChecklistTask(runDir, task.id)).toBeUndefined();
    expect(() => updateChecklistTask(runDir, task.id, { subject: 'Nope' })).toThrow(/not found/);
    expect(createChecklistTask(runDir, { subject: 'After delete', description: 'Task' }).id).toBe('2');
  });

  it('notifies only after successful mutations', () => {
    const notifications: string[] = [];
    const unsubscribe = onChecklistUpdated((dir) => notifications.push(dir));
    const task = createChecklistTask(runDir, { subject: 'Notify', description: 'Task' });
    updateChecklistTask(runDir, task.id, { status: 'in_progress' });
    expect(() => updateChecklistTask(runDir, '99', { status: 'completed' })).toThrow();
    deleteChecklistTask(runDir, task.id);
    expect(notifications).toEqual([runDir, runDir, runDir]);
    unsubscribe();
    createChecklistTask(runDir, { subject: 'No listener', description: 'Task' });
    expect(notifications).toHaveLength(3);
  });
});
