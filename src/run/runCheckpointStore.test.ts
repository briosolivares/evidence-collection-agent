import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ceilingFromCheckpoint,
  ceilingToCheckpoint,
  HARNESS_DIR,
  openRunCheckpointStore,
  RUN_CHECKPOINT_FILENAME,
  RUN_CHECKPOINT_TMP_FILENAME,
  RUN_LOCK_FILENAME,
  runCheckpointV1Schema,
  UNBOUNDED_CEILING,
  type RunCheckpointV1,
} from './runCheckpointStore.js';

// Pure I/O and locking over a temp run directory — no model calls, no
// browser — matching the hermetic-suite convention used across this
// codebase's other run-dir helpers (artifacts.test.ts, transcript.test.ts,
// runBudget.test.ts).

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'run-checkpoint-store-test-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function harnessPath(...segments: string[]): string {
  return join(runDir, HARNESS_DIR, ...segments);
}

/** A minimal, valid checkpoint with every ceiling unbounded and no worker
 * session — the only shape valid at runStatus 'initializing'. */
function baseCheckpoint(overrides: Partial<RunCheckpointV1> = {}): RunCheckpointV1 {
  const checkpoint: RunCheckpointV1 = {
    schemaVersion: 1,
    checkpointRevision: 1,
    runStatus: 'initializing',
    updatedAt: new Date(0).toISOString(),
    runConfiguration: {
      model: 'claude-sonnet-5',
      maxOutputTokens: 8192,
      maxTurns: UNBOUNDED_CEILING,
      maxContextTokens: 180_000,
    },
    budget: {
      config: {
        maxWorkerTurns: UNBOUNDED_CEILING,
        maxToolCalls: UNBOUNDED_CEILING,
        maxModelTokens: UNBOUNDED_CEILING,
        maxToolResultBytes: UNBOUNDED_CEILING,
        maxWallTimeMs: UNBOUNDED_CEILING,
        maxVerifierCorrections: UNBOUNDED_CEILING,
      },
      elapsedWallTimeMs: 0,
      roles: {},
      toolCalls: 0,
      toolResultBytes: 0,
      corrections: 0,
    },
    runProgress: {
      currentCycle: 0,
      completionCheckFailures: 0,
      cycleRecords: [],
    },
  };
  // Test-only builder: callers are trusted to pass a shape that still
  // satisfies RunCheckpointV1 as a whole (e.g. workerSession alongside a
  // non-initializing runStatus). Partial<T>'s optional-everywhere typing
  // otherwise fights object-spread inference here for no real benefit.
  return { ...checkpoint, ...overrides } as RunCheckpointV1;
}

/** A checkpoint valid at any non-initializing runStatus: same as
 * baseCheckpoint, but with the required workerSession attached and
 * runStatus advanced to 'ready_for_model'. */
function withWorkerSession(overrides: Partial<RunCheckpointV1> = {}): RunCheckpointV1 {
  return baseCheckpoint({
    runStatus: 'ready_for_model',
    workerSession: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'do the task' }] }],
      turnCount: 1,
      peakContextTokens: 1000,
      protocolCorrections: 0,
      startedMs: 1000,
    },
    ...overrides,
  });
}

describe('ceilingToCheckpoint / ceilingFromCheckpoint', () => {
  it('round-trips Infinity through the unbounded sentinel', () => {
    expect(ceilingToCheckpoint(Infinity)).toBe('unbounded');
    expect(ceilingFromCheckpoint('unbounded')).toBe(Infinity);
  });

  it('passes finite numbers through unchanged', () => {
    expect(ceilingToCheckpoint(42)).toBe(42);
    expect(ceilingFromCheckpoint(42)).toBe(42);
    expect(ceilingToCheckpoint(0)).toBe(0);
  });

  it('rejects NaN', () => {
    expect(() => ceilingToCheckpoint(Number.NaN)).toThrow(/NaN/);
  });
});

describe('runCheckpointV1Schema', () => {
  it('accepts an initializing checkpoint with no workerSession', () => {
    expect(runCheckpointV1Schema.safeParse(baseCheckpoint()).success).toBe(true);
  });

  it.each(['ready_for_model', 'executing_tools', 'verifying', 'terminal'] as const)(
    'rejects a %s checkpoint with no workerSession',
    (runStatus) => {
      const result = runCheckpointV1Schema.safeParse(baseCheckpoint({ runStatus }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('workerSession'))).toBe(
          true,
        );
      }
    },
  );

  it.each(['ready_for_model', 'executing_tools', 'verifying', 'terminal'] as const)(
    'accepts a %s checkpoint that carries workerSession',
    (runStatus) => {
      const result = runCheckpointV1Schema.safeParse(withWorkerSession({ runStatus }));
      expect(result.success).toBe(true);
    },
  );

  it('accepts the unbounded sentinel for every budget ceiling and for maxTurns', () => {
    const checkpoint = baseCheckpoint();
    expect(checkpoint.runConfiguration.maxTurns).toBe('unbounded');
    expect(runCheckpointV1Schema.safeParse(checkpoint).success).toBe(true);
  });

  it('rejects a null ceiling instead of treating it as zero', () => {
    const checkpoint = baseCheckpoint();
    const withNullCeiling = {
      ...checkpoint,
      budget: {
        ...checkpoint.budget,
        config: { ...checkpoint.budget.config, maxWorkerTurns: null },
      },
    };
    const result = runCheckpointV1Schema.safeParse(withNullCeiling);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join('.') === 'budget.config.maxWorkerTurns'),
      ).toBe(true);
    }
  });
});

describe('openRunCheckpointStore: save/load round trip', () => {
  it('round-trips a saved checkpoint byte-for-byte on re-serialize', async () => {
    const store = await openRunCheckpointStore(runDir);
    const checkpoint = withWorkerSession({ checkpointRevision: 1 });

    await store.save(checkpoint);

    const onDisk = readFileSync(harnessPath(RUN_CHECKPOINT_FILENAME), 'utf8');
    const loaded = store.load();
    expect(loaded).toEqual(checkpoint);
    expect(`${JSON.stringify(loaded, null, 2)}\n`).toBe(onDisk);

    await store.close();
  });

  it('returns undefined from load() when nothing has been saved yet', async () => {
    const store = await openRunCheckpointStore(runDir);
    expect(store.load()).toBeUndefined();
    await store.close();
  });

  it('restores Infinity ceilings from the unbounded sentinel after a round trip, including maxTurns', async () => {
    const store = await openRunCheckpointStore(runDir);
    const checkpoint = withWorkerSession({ checkpointRevision: 1 });

    await store.save(checkpoint);
    const loaded = store.load()!;

    expect(loaded.runConfiguration.maxTurns).toBe('unbounded');
    expect(ceilingFromCheckpoint(loaded.runConfiguration.maxTurns)).toBe(Infinity);
    expect(ceilingFromCheckpoint(loaded.budget.config.maxWorkerTurns)).toBe(Infinity);
    expect(ceilingFromCheckpoint(loaded.budget.config.maxWallTimeMs)).toBe(Infinity);

    await store.close();
  });

  it('rejects a checkpoint with a null ceiling and writes nothing', async () => {
    const store = await openRunCheckpointStore(runDir);
    const checkpoint = withWorkerSession({ checkpointRevision: 1 });
    const invalid = {
      ...checkpoint,
      budget: {
        ...checkpoint.budget,
        config: { ...checkpoint.budget.config, maxWorkerTurns: null },
      },
    } as unknown as RunCheckpointV1;

    await expect(store.save(invalid)).rejects.toThrow();
    expect(store.load()).toBeUndefined();

    await store.close();
  });

  it('rejects a ready_for_model save with no workerSession, and an initializing one succeeds', async () => {
    const store = await openRunCheckpointStore(runDir);

    await expect(store.save(baseCheckpoint({ runStatus: 'ready_for_model' }))).rejects.toThrow(
      /workerSession/,
    );
    expect(store.load()).toBeUndefined();

    await store.save(baseCheckpoint());
    expect(store.load()?.runStatus).toBe('initializing');

    await store.close();
  });

  it('round-trips workerSession fields and budget usage/counters exactly', async () => {
    const store = await openRunCheckpointStore(runDir);
    const checkpoint = withWorkerSession({
      checkpointRevision: 1,
      budget: {
        config: {
          maxWorkerTurns: 40,
          maxToolCalls: UNBOUNDED_CEILING,
          maxModelTokens: 500_000,
          maxToolResultBytes: UNBOUNDED_CEILING,
          maxWallTimeMs: 3_600_000,
          maxVerifierCorrections: 3,
        },
        elapsedWallTimeMs: 12_345,
        roles: {
          worker: {
            turns: 4,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 50,
            wallClockMs: 9000,
          },
          verifier: {
            turns: 1,
            inputTokens: 300,
            outputTokens: 40,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            wallClockMs: 500,
          },
        },
        toolCalls: 12,
        toolResultBytes: 34_567,
        corrections: 1,
      },
      workerSession: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do the task' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
        turnCount: 3,
        peakContextTokens: 45_000,
        protocolCorrections: 2,
        startedMs: 1_700_000_000_000,
      },
    });

    await store.save(checkpoint);
    const loaded = store.load();

    expect(loaded).toEqual(checkpoint);
    expect(loaded?.workerSession).toEqual(checkpoint.workerSession);
    expect(loaded?.budget).toEqual(checkpoint.budget);

    await store.close();
  });

  it('round-trips the optional sections: runConfiguration.harness, initializer, pendingTurn, finalOutcome', async () => {
    const store = await openRunCheckpointStore(runDir);
    const checkpoint = withWorkerSession({
      checkpointRevision: 1,
      runStatus: 'executing_tools',
      runConfiguration: {
        model: 'claude-sonnet-5',
        maxOutputTokens: 8192,
        maxTurns: UNBOUNDED_CEILING,
        maxContextTokens: 180_000,
        startUrl: 'https://example.com',
        harness: {
          maxWorkerCycles: 6,
          maxCompletionCheckFailures: 2,
          contractAuthor: 'initializer',
        },
      },
      initializer: {
        mode: 'contract',
        contractRevision: 2,
      },
      runProgress: {
        currentCycle: 2,
        completionCheckFailures: 1,
        cycleRecords: [{ cycle: 1, workerStatus: 'completed' }],
        completedCycleMetrics: [{ turns: 3 }],
      },
      pendingTurn: {
        turnNumber: 4,
        assistantMessage: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'click', input: { ref: 'x' } }],
        },
        toolCalls: [
          {
            request: { id: 't1', name: 'click', input: { ref: 'x' } },
            executionStatus: 'finished',
            result: { toolCallId: 't1', isError: false, content: 'ok' },
          },
        ],
      },
      finalOutcome: { status: 'verified', finalText: 'done' },
    });

    await store.save(checkpoint);
    expect(store.load()).toEqual(checkpoint);

    await store.close();
  });
});

describe('checkpointRevision monotonicity', () => {
  it('rejects a duplicate revision', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));

    await expect(store.save(withWorkerSession({ checkpointRevision: 1 }))).rejects.toThrow(
      /revision/i,
    );
    expect(store.load()?.checkpointRevision).toBe(1);

    await store.close();
  });

  it('rejects a stale (lower) revision', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 5 }));

    await expect(store.save(withWorkerSession({ checkpointRevision: 3 }))).rejects.toThrow(
      /revision/i,
    );
    expect(store.load()?.checkpointRevision).toBe(5);

    await store.close();
  });

  it('honors the on-disk revision after closing and reopening the same run directory', async () => {
    const store1 = await openRunCheckpointStore(runDir);
    await store1.save(withWorkerSession({ checkpointRevision: 7 }));
    await store1.close();

    const store2 = await openRunCheckpointStore(runDir);
    await expect(store2.save(withWorkerSession({ checkpointRevision: 7 }))).rejects.toThrow(
      /revision/i,
    );
    await store2.save(withWorkerSession({ checkpointRevision: 8 }));
    expect(store2.load()?.checkpointRevision).toBe(8);

    await store2.close();
  });
});

describe('atomic replacement', () => {
  it('keeps the previous checkpoint readable when a failure happens between the temp write and the rename', async () => {
    let failNext = false;
    const store = await openRunCheckpointStore(runDir, {
      afterTempWrite: () => {
        if (failNext) throw new Error('injected failure after temp write');
      },
    });

    await store.save(withWorkerSession({ checkpointRevision: 1 }));
    const beforeFailedSave = store.load();

    failNext = true;
    await expect(store.save(withWorkerSession({ checkpointRevision: 2 }))).rejects.toThrow(
      /injected failure/,
    );

    const afterFailedSave = store.load();
    expect(afterFailedSave).toEqual(beforeFailedSave);
    expect(afterFailedSave?.checkpointRevision).toBe(1);

    // The store itself is not poisoned by a transient write failure — a
    // later save can still succeed.
    failNext = false;
    await store.save(withWorkerSession({ checkpointRevision: 2 }));
    expect(store.load()?.checkpointRevision).toBe(2);

    await store.close();
  });
});

describe('concurrent saves', () => {
  it('serializes concurrent save() calls rather than interleaving them', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;

    const store = await openRunCheckpointStore(runDir, {
      beforeWrite: async () => {
        calls += 1;
        const label = calls;
        order.push(`start-${label}`);
        if (label === 1) await firstGate;
        order.push(`end-${label}`);
      },
    });

    const firstSave = store.save(withWorkerSession({ checkpointRevision: 1 }));
    const secondSave = store.save(withWorkerSession({ checkpointRevision: 2 }));

    // Give the second save every opportunity to jump ahead if the queue
    // were broken; it must not, because the first save is still parked on
    // firstGate.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start-1']);

    releaseFirst?.();
    await Promise.all([firstSave, secondSave]);

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(store.load()?.checkpointRevision).toBe(2);

    await store.close();
  });
});

describe('lock ownership', () => {
  it('refuses to open a second store while a live process holds the lock', async () => {
    const store = await openRunCheckpointStore(runDir);

    await expect(openRunCheckpointStore(runDir)).rejects.toThrow(/already open|locked|held/i);

    await store.close();
  });

  it('recovers a stale lock left by a dead process and retries creation once', async () => {
    mkdirSync(harnessPath(), { recursive: true });
    chmodSync(harnessPath(), 0o700);
    const deadPid = 999_999;
    writeFileSync(
      harnessPath(RUN_LOCK_FILENAME),
      JSON.stringify({
        harnessInstanceId: 'stale-instance',
        processId: deadPid,
        acquiredAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );

    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));
    expect(store.load()?.checkpointRevision).toBe(1);

    await store.close();
  });

  it('fails loudly on a corrupt lock file and leaves it untouched', async () => {
    mkdirSync(harnessPath(), { recursive: true });
    chmodSync(harnessPath(), 0o700);
    const lockPath = harnessPath(RUN_LOCK_FILENAME);
    writeFileSync(lockPath, 'not json', { mode: 0o600 });

    await expect(openRunCheckpointStore(runDir)).rejects.toThrow();
    expect(readFileSync(lockPath, 'utf8')).toBe('not json');
  });

  it('makes the next save fail once the lock is reassigned to a different instance', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));

    const lockPath = harnessPath(RUN_LOCK_FILENAME);
    const currentLock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      lockPath,
      JSON.stringify({ ...currentLock, harnessInstanceId: 'someone-else' }, null, 2),
      { mode: 0o600 },
    );

    await expect(store.save(withWorkerSession({ checkpointRevision: 2 }))).rejects.toThrow(
      /lock/i,
    );
    // Cancelled for good: a later save fails too, without the lock needing
    // to change again.
    await expect(store.save(withWorkerSession({ checkpointRevision: 3 }))).rejects.toThrow();
    expect(store.load()?.checkpointRevision).toBe(1);
  });
});

describe('close', () => {
  it('is idempotent', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('rejects a save issued after close', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.close();

    await expect(store.save(withWorkerSession({ checkpointRevision: 1 }))).rejects.toThrow(
      /closed/,
    );
  });

  it('flushes a pending save before releasing the lock', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const store = await openRunCheckpointStore(runDir, { beforeWrite: () => gate });

    const pendingSave = store.save(withWorkerSession({ checkpointRevision: 1 }));
    const closing = store.close();

    // The lock must still be held while the save is parked on the gate.
    await expect(openRunCheckpointStore(runDir)).rejects.toThrow();

    releaseGate?.();
    await pendingSave;
    await closing;

    expect(store.load()?.checkpointRevision).toBe(1);

    // Released: a fresh open now succeeds.
    const reopened = await openRunCheckpointStore(runDir);
    await reopened.close();
  });
});

describe('checkpoint.json.tmp handling', () => {
  it('ignores a leftover checkpoint.json.tmp on load', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));

    writeFileSync(harnessPath(RUN_CHECKPOINT_TMP_FILENAME), 'garbage, not even json');

    expect(store.load()?.checkpointRevision).toBe(1);

    await store.close();
  });
});

describe('invalid on-disk checkpoint', () => {
  it('throws opening the store when the on-disk checkpoint is present but invalid', async () => {
    mkdirSync(harnessPath(), { recursive: true });
    chmodSync(harnessPath(), 0o700);
    writeFileSync(harnessPath(RUN_CHECKPOINT_FILENAME), JSON.stringify({ schemaVersion: 1 }), {
      mode: 0o600,
    });

    await expect(openRunCheckpointStore(runDir)).rejects.toThrow();
  });

  it('throws on load() when the checkpoint becomes invalid after a valid open', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));

    writeFileSync(harnessPath(RUN_CHECKPOINT_FILENAME), JSON.stringify({ schemaVersion: 1 }), {
      mode: 0o600,
    });

    expect(() => store.load()).toThrow();

    await store.close();
  });
});

describe('POSIX modes', () => {
  it('creates harness/ with mode 0700 and its files with mode 0600', async () => {
    const store = await openRunCheckpointStore(runDir);
    await store.save(withWorkerSession({ checkpointRevision: 1 }));

    expect(statSync(harnessPath()).mode & 0o777).toBe(0o700);
    expect(statSync(harnessPath(RUN_LOCK_FILENAME)).mode & 0o777).toBe(0o600);
    expect(statSync(harnessPath(RUN_CHECKPOINT_FILENAME)).mode & 0o777).toBe(0o600);

    await store.close();
  });

  it('validates rather than re-permissions an existing harness/ with the wrong mode', async () => {
    mkdirSync(harnessPath(), { recursive: true });
    chmodSync(harnessPath(), 0o755);

    await expect(openRunCheckpointStore(runDir)).rejects.toThrow(/mode/i);
    expect(statSync(harnessPath()).mode & 0o777).toBe(0o755);
  });
});
