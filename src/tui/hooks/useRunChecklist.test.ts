import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initManifest, writeArtifact } from '../../run/artifacts.js';
import { createChecklistTask, updateChecklistTask } from '../../run/checklist.js';
import { createRunChecklistStore } from './useRunChecklist.js';

let runDir: string;
const stores: Array<{ dispose(): void }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  runDir = mkdtempSync(join(tmpdir(), 'run-checklist-store-test-'));
  initManifest(runDir, 'store test');
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  rmSync(runDir, { recursive: true, force: true });
});

function store() {
  const value = createRunChecklistStore(runDir);
  stores.push(value);
  return value;
}

describe('createRunChecklistStore', () => {
  it('loads immediately and reports empty lists as hidden', () => {
    const empty = store();
    expect(empty.getSnapshot()).toEqual({ tasks: [], visible: false });

    createChecklistTask(runDir, { subject: 'First', description: 'Task' });
    const loaded = store();
    expect(loaded.getSnapshot().visible).toBe(true);
    expect(loaded.getSnapshot().tasks.map((task) => task.id)).toEqual(['1']);
  });

  it('coalesces same-process invalidation and rereads disk', () => {
    const current = store();
    const listener = vi.fn();
    current.subscribe(listener);
    createChecklistTask(runDir, { subject: 'First', description: 'Task' });
    createChecklistTask(runDir, { subject: 'Second', description: 'Task' });
    expect(current.getSnapshot().tasks).toHaveLength(0);
    vi.advanceTimersByTime(49);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(current.getSnapshot().tasks).toHaveLength(2);
  });

  it('observes an external checklist file change through fs.watch', async () => {
    vi.useRealTimers();
    createChecklistTask(runDir, { subject: 'External', description: 'Before' });
    const current = store();
    writeFileSync(join(runDir, 'checklist', '1.json'), JSON.stringify({
      id: '1', subject: 'External', description: 'After', status: 'pending',
    }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(current.getSnapshot().tasks[0]?.description).toBe('After');
  });

  it('keeps the last good snapshot when disk JSON is temporarily invalid', () => {
    createChecklistTask(runDir, { subject: 'Stable', description: 'Good' });
    const current = store();
    writeFileSync(join(runDir, 'checklist', '1.json'), '{bad json');
    current.invalidate();
    vi.advanceTimersByTime(50);
    expect(current.getSnapshot().tasks[0]?.description).toBe('Good');

    writeFileSync(join(runDir, 'checklist', '1.json'), JSON.stringify({
      id: '1', subject: 'Stable', description: 'Recovered', status: 'pending',
    }) + '\n');
    current.invalidate();
    vi.advanceTimersByTime(50);
    expect(current.getSnapshot().tasks[0]?.description).toBe('Recovered');
  });

  it('polls unresolved tasks and does not poll once all are completed', () => {
    const task = createChecklistTask(runDir, { subject: 'Poll', description: 'Pending' });
    const current = store();
    writeArtifact(runDir, 'checklist/1.json', Buffer.from(JSON.stringify({
      ...task, status: 'in_progress',
    }) + '\n'), { managedState: 'checklist' });
    vi.advanceTimersByTime(5_000);
    expect(current.getSnapshot().tasks[0]?.status).toBe('in_progress');

    writeArtifact(runDir, 'checklist/1.json', Buffer.from(JSON.stringify({
      ...task, status: 'completed',
    }) + '\n'), { managedState: 'checklist' });
    current.invalidate();
    vi.advanceTimersByTime(50);
    expect(current.getSnapshot().visible).toBe(true);
  });

  it('keeps all-completed tasks visible for five seconds, then hides without deleting', () => {
    const task = createChecklistTask(runDir, { subject: 'Done', description: 'Complete' });
    updateChecklistTask(runDir, task.id, { status: 'completed' });
    const current = store();
    expect(current.getSnapshot().visible).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(current.getSnapshot().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(current.getSnapshot().visible).toBe(false);

    updateChecklistTask(runDir, task.id, { status: 'pending' });
    vi.advanceTimersByTime(50);
    expect(current.getSnapshot().visible).toBe(true);
    expect(current.getSnapshot().tasks).toHaveLength(1);
  });

  it('cleans up invalidation, polling, debounce, completion, and file watchers', () => {
    createChecklistTask(runDir, { subject: 'Cleanup', description: 'Task' });
    const current = store();
    const listener = vi.fn();
    current.subscribe(listener);
    current.dispose();
    createChecklistTask(runDir, { subject: 'After', description: 'No update' });
    current.invalidate();
    vi.advanceTimersByTime(10_000);
    expect(listener).not.toHaveBeenCalled();
  });
});
