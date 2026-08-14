import { describe, expect, it } from 'vitest';

import { createWorkerSession, type WorkerSessionDeps } from '../loop/workerSession.js';
import { createRunBudgetTracker } from '../run/runBudget.js';
import {
  runCheckpointV1Schema,
  UNBOUNDED_CEILING,
  type RunCheckpointStore,
  type RunCheckpointV1,
} from '../run/runCheckpointStore.js';
import { createRunCheckpointWriter, type RunProgress } from './runCheckpoint.js';

// Pure assembly logic over fakes — no filesystem, no model, no browser: this
// suite proves the writer builds SCHEMA-VALID checkpoints with a strictly
// increasing revision and a faithful conversion of live session/budget state,
// leaving `openRunCheckpointStore`'s own I/O and locking guarantees to its
// own test suite (runCheckpointStore.test.ts).

/** A fake WorkerSessionDeps: createWorkerSession itself performs no I/O (see
 * workerSession.ts — only runWorkerTurn touches the run directory), so
 * `runDir` here is never actually read from or written to. */
const FAKE_DEPS: WorkerSessionDeps = {
  callModel: async () => {
    throw new Error('not used: createWorkerSession never calls the model');
  },
  registry: new Map(),
  runDir: '/fake/run/dir',
};

const NO_PROGRESS: RunProgress = { currentCycle: 0, completionCheckFailures: 0, cycleRecords: [] };

/** An in-memory double for RunCheckpointStore: every accepted save is kept,
 * in order, so a test can inspect exactly what the writer produced. */
function fakeStore(): { store: RunCheckpointStore; saved: RunCheckpointV1[] } {
  const saved: RunCheckpointV1[] = [];
  let closed = false;
  const store: RunCheckpointStore = {
    load: () => saved.at(-1),
    save: async (checkpoint) => {
      if (closed) throw new Error('store is closed');
      saved.push(checkpoint);
    },
    close: async () => {
      closed = true;
    },
  };
  return { store, saved };
}

const RUN_CONFIGURATION: RunCheckpointV1['runConfiguration'] = {
  model: 'claude-sonnet-5',
  toolProfile: 'atomic',
  maxOutputTokens: 8192,
  maxTurns: UNBOUNDED_CEILING,
  maxContextTokens: 180_000,
  harness: {
    maxWorkerCycles: 3,
    maxCompletionCheckFailures: 5,
    outputContract: true,
    contractAuthor: 'worker',
  },
};

describe('createRunCheckpointWriter', () => {
  it('assigns a strictly increasing checkpointRevision across every save method', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });

    await writer.saveInitializing();
    await writer.saveInitializerAccepted({ mode: 'contract' });
    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });
    await writer.saveVerifying({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });
    await writer.saveTerminal({
      session,
      progress: { ...NO_PROGRESS, currentCycle: 1 },
      outcome: { status: 'verified', finalText: 'done' },
    });

    expect(saved.map((checkpoint) => checkpoint.checkpointRevision)).toEqual([1, 2, 3, 4, 5]);
    // Monotonic, not merely distinct: every later save is strictly greater
    // than the one before it — the exact property RunCheckpointStore.save
    // enforces on the other side of this seam.
    for (let index = 1; index < saved.length; index += 1) {
      expect(saved[index]!.checkpointRevision).toBeGreaterThan(saved[index - 1]!.checkpointRevision);
    }
  });

  it('carries the accepted initializer forward onto every later save', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });

    await writer.saveInitializing();
    expect(saved.at(-1)?.initializer).toBeUndefined();

    await writer.saveInitializerAccepted({
      mode: 'prose',
      proseAccepted: { intent: 'goal', contract: 'criteria' },
    });
    expect(saved.at(-1)?.initializer).toEqual({
      mode: 'prose',
      proseAccepted: { intent: 'goal', contract: 'criteria' },
    });

    await writer.saveInitializerAccepted({
      mode: 'prose',
      proseAccepted: { intent: 'goal', contract: 'criteria' },
      filesWritten: true,
    });
    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });

    // The prose acceptance (now with filesWritten) survives onto the
    // ready_for_model save without being re-supplied.
    expect(saved.at(-1)?.initializer).toEqual({
      mode: 'prose',
      proseAccepted: { intent: 'goal', contract: 'criteria' },
      filesWritten: true,
    });
  });

  it("converts Infinity budget ceilings to the 'unbounded' sentinel", async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: Infinity,
      maxToolCalls: Infinity,
      maxModelTokens: 50_000,
      maxToolResultBytes: Infinity,
      maxWallTimeMs: Infinity,
      maxVerifierCorrections: 0,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });

    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });

    const checkpoint = saved.at(-1)!;
    expect(checkpoint.budget.config).toEqual({
      maxWorkerTurns: UNBOUNDED_CEILING,
      maxToolCalls: UNBOUNDED_CEILING,
      maxModelTokens: 50_000,
      maxToolResultBytes: UNBOUNDED_CEILING,
      maxWallTimeMs: UNBOUNDED_CEILING,
      maxVerifierCorrections: 0,
    });
  });

  it('produces checkpoints that validate against runCheckpointV1Schema at every runStatus', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });

    await writer.saveInitializing();
    await writer.saveInitializerAccepted({ mode: 'contract', contractRevision: 1 });
    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });
    await writer.saveVerifying({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });
    await writer.saveTerminal({
      session,
      progress: { ...NO_PROGRESS, currentCycle: 1 },
      outcome: { status: 'verified', finalText: 'done' },
    });

    expect(saved).toHaveLength(5);
    for (const checkpoint of saved) {
      expect(() => runCheckpointV1Schema.parse(checkpoint)).not.toThrow();
    }
  });

  it('assembles the workerSession snapshot to match captureWorkerSessionSnapshot exactly', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });
    session.state.turnCount = 3;
    session.peakContextTokens = 4200;
    session.protocolCorrections = 1;

    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 2 } });

    const stored = saved.at(-1)!.workerSession!;
    expect(stored.messages).toEqual(session.state.messages);
    expect(stored.turnCount).toBe(3);
    expect(stored.peakContextTokens).toBe(4200);
    expect(stored.protocolCorrections).toBe(1);
    expect(stored.startedMs).toBe(session.startedMs);

    // Round-trips independently: mutating the live session after the save
    // must never reach back into the already-recorded checkpoint (the same
    // deep-copy guarantee captureWorkerSessionSnapshot documents).
    session.state.messages.push({ role: 'user', content: [{ type: 'text', text: 'more' }] });
    expect(stored.messages).toHaveLength(1);
  });

  it('assembles the budget snapshot to match captureRunBudgetSnapshot exactly', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    budget.recordModelUsage('worker', { input_tokens: 100, output_tokens: 20 }, 500);
    budget.recordToolCalls(2);
    budget.recordToolResultBytes(64);
    budget.recordCorrection();

    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });
    const session = createWorkerSession('do the task', FAKE_DEPS, { budget, maxContextTokens: 10_000 });

    await writer.saveReadyForModel({ session, progress: { ...NO_PROGRESS, currentCycle: 1 } });

    const stored = saved.at(-1)!.budget;
    expect(stored.roles).toEqual(budget.roleUsage());
    expect(stored.toolCalls).toBe(2);
    expect(stored.toolResultBytes).toBe(64);
    expect(stored.corrections).toBe(1);
    expect(stored.elapsedWallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('omits workerSession on saveTerminal when no session is given', async () => {
    const { store, saved } = fakeStore();
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(store, { runConfiguration: RUN_CONFIGURATION, budget });

    await writer.saveTerminal({ progress: NO_PROGRESS, outcome: { status: 'verified', finalText: '' } });

    const checkpoint = saved.at(-1)!;
    expect('workerSession' in checkpoint).toBe(false);
    // The fake store above (unlike the real one) performs no validation, so
    // this proves the writer's own behavior (omit, don't fabricate); a real
    // RunCheckpointStore would reject exactly this shape, per
    // runCheckpointV1Schema's superRefine (workerSession required once
    // runStatus leaves 'initializing') — every production call site always
    // has a live session by the time it reaches saveTerminal, so that
    // rejection is never actually exercised.
    expect(runCheckpointV1Schema.safeParse(checkpoint).success).toBe(false);
  });

  it('close() delegates to the underlying store', async () => {
    const { store } = fakeStore();
    let closed = false;
    const wrapped: RunCheckpointStore = {
      ...store,
      close: async () => {
        closed = true;
        await store.close();
      },
    };
    const budget = createRunBudgetTracker({
      maxWorkerTurns: 10,
      maxToolCalls: 10,
      maxModelTokens: 10_000,
      maxToolResultBytes: 10_000,
      maxWallTimeMs: 60_000,
      maxVerifierCorrections: 2,
    });
    const writer = createRunCheckpointWriter(wrapped, { runConfiguration: RUN_CONFIGURATION, budget });
    await writer.close();
    expect(closed).toBe(true);
  });
});
