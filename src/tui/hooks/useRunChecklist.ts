import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useState } from 'react';

import {
  listChecklistTasks,
  onChecklistUpdated,
  type ChecklistTask,
} from '../../run/checklist.js';

const RELOAD_DEBOUNCE_MS = 50;
const FALLBACK_POLL_MS = 5_000;
const COMPLETED_VISIBLE_MS = 5_000;

export interface RunChecklistSnapshot {
  readonly tasks: readonly ChecklistTask[];
  readonly visible: boolean;
}

export interface RunChecklistStore {
  getSnapshot(): RunChecklistSnapshot;
  subscribe(listener: () => void): () => void;
  /** Trigger a debounced disk reread; useful for non-filesystem invalidation sources. */
  invalidate(): void;
  dispose(): void;
}

const EMPTY_SNAPSHOT: RunChecklistSnapshot = Object.freeze({ tasks: [], visible: false });

/**
 * One disk-backed checklist subscription for a run. Disk is always the source
 * of truth: notifications only invalidate and every reload reparses files.
 */
export function createRunChecklistStore(runDir: string | undefined): RunChecklistStore {
  if (runDir === undefined) return createEmptyStore();

  let snapshot: RunChecklistSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let watcher: FSWatcher | undefined;
  let unsubscribe: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let completedHideTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const setSnapshot = (tasks: ChecklistTask[], visible: boolean) => {
    const changed =
      snapshot.visible !== visible || JSON.stringify(snapshot.tasks) !== JSON.stringify(tasks);
    if (!changed) return;
    snapshot = { tasks, visible };
    notify();
  };

  const clearPoll = () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const scheduleCompletedHide = () => {
    if (completedHideTimer !== undefined) clearTimeout(completedHideTimer);
    completedHideTimer = setTimeout(() => {
      completedHideTimer = undefined;
      if (!disposed && snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === 'completed')) {
        setSnapshot([...snapshot.tasks], false);
      }
    }, COMPLETED_VISIBLE_MS);
  };

  const reload = () => {
    if (disposed) return;
    let tasks: ChecklistTask[];
    try {
      tasks = listChecklistTasks(runDir);
    } catch {
      // Keep the last good snapshot while a write is mid-flight or malformed.
      return;
    }
    if (tasks.length === 0) {
      if (completedHideTimer !== undefined) clearTimeout(completedHideTimer);
      completedHideTimer = undefined;
      clearPoll();
      setSnapshot(tasks, false);
      return;
    }
    const allCompleted = tasks.every((task) => task.status === 'completed');
    if (allCompleted) {
      clearPoll();
      const tasksChanged = JSON.stringify(snapshot.tasks) !== JSON.stringify(tasks);
      if (tasksChanged) {
        setSnapshot(tasks, true);
        scheduleCompletedHide();
      }
    } else {
      if (completedHideTimer !== undefined) clearTimeout(completedHideTimer);
      completedHideTimer = undefined;
      setSnapshot(tasks, true);
      if (pollTimer === undefined) pollTimer = setInterval(reload, FALLBACK_POLL_MS);
    }
  };

  const invalidate = () => {
    if (disposed || debounceTimer !== undefined) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      reload();
    }, RELOAD_DEBOUNCE_MS);
  };

  reload();
  unsubscribe = onChecklistUpdated((changedRunDir) => {
    if (changedRunDir === runDir) invalidate();
  });
  try {
    watcher = watch(join(runDir, 'checklist'), () => invalidate());
    watcher.on('error', () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // The run may be torn down while a view is changing; polling/subscription
    // remain useful when the directory watcher cannot be established.
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      watcher?.close();
      watcher = undefined;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (completedHideTimer !== undefined) clearTimeout(completedHideTimer);
      debounceTimer = undefined;
      completedHideTimer = undefined;
      clearPoll();
      listeners.clear();
    },
  };
}

function createEmptyStore(): RunChecklistStore {
  return {
    getSnapshot: () => EMPTY_SNAPSHOT,
    subscribe: () => () => undefined,
    invalidate: () => undefined,
    dispose: () => undefined,
  };
}

/** React adapter for the run checklist's single external subscription. */
export function useRunChecklist(runDir: string | undefined): RunChecklistSnapshot {
  const [current, setCurrent] = useState<{
    runDir: string | undefined;
    snapshot: RunChecklistSnapshot;
  }>({ runDir: undefined, snapshot: EMPTY_SNAPSHOT });

  useEffect(() => {
    // Store construction performs the immediate disk load and installs its
    // invalidation sources. Keeping it inside the effect prevents watchers or
    // timers from leaking if React abandons a render before commit.
    const store = createRunChecklistStore(runDir);
    const sync = () => setCurrent({ runDir, snapshot: store.getSnapshot() });
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [runDir]);

  // A run change hides the old snapshot on the first render, before the new
  // effect has loaded disk, so one run can never flash another run's tasks.
  return current.runDir === runDir ? current.snapshot : EMPTY_SNAPSHOT;
}
