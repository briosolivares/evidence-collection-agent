import { describe, expect, it } from 'vitest';

import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  validateRunBudgetConfig,
  type RunBudgetConfig,
  type RunBudgetSnapshot,
} from './runBudget.js';

const UNBOUNDED: RunBudgetConfig = {
  maxWorkerTurns: Infinity,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxWallTimeMs: Infinity,
  maxVerifierCorrections: Infinity,
};

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
};

describe('validateRunBudgetConfig', () => {
  it('accepts Infinity for every field and finite integers in range', () => {
    expect(() => validateRunBudgetConfig(UNBOUNDED)).not.toThrow();
    expect(() =>
      validateRunBudgetConfig({
        maxWorkerTurns: 10,
        maxToolCalls: 0,
        maxModelTokens: 1_000_000,
        maxWallTimeMs: 60_000,
        maxVerifierCorrections: 0,
      }),
    ).not.toThrow();
  });

  it.each([
    ['maxWorkerTurns NaN', { maxWorkerTurns: Number.NaN }],
    ['maxWorkerTurns 0', { maxWorkerTurns: 0 }],
    ['maxWorkerTurns fractional', { maxWorkerTurns: 2.5 }],
    ['maxToolCalls negative', { maxToolCalls: -1 }],
    ['maxModelTokens NaN', { maxModelTokens: Number.NaN }],
    ['maxWallTimeMs 0', { maxWallTimeMs: 0 }],
    ['maxVerifierCorrections negative', { maxVerifierCorrections: -2 }],
  ])('rejects %s naming the field', (_label, overrides) => {
    const config = { ...UNBOUNDED, ...overrides };
    const field = Object.keys(overrides)[0]!;
    expect(() => validateRunBudgetConfig(config)).toThrow(new RegExp(field));
    expect(() => createRunBudgetTracker(config)).toThrow(new RegExp(field));
  });
});

describe('createRunBudgetTracker', () => {
  it('accumulates per-role usage and exposes all-role token totals', () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    tracker.recordModelUsage('worker', USAGE, 40);
    tracker.recordModelUsage('worker', USAGE, 60);
    tracker.recordModelUsage('verifier', USAGE, 25);

    expect(tracker.workerTurnsUsed()).toBe(2);
    expect(tracker.totalModelTokens()).toBe(3 * (100 + 50 + 10 + 5));
    const roles = tracker.roleUsage();
    expect(roles.worker).toEqual({
      turns: 2,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
      wallClockMs: 100,
    });
    expect(roles.verifier?.turns).toBe(1);
    expect(roles.initializer).toBeUndefined();
    // Snapshots are copies — mutating one changes nothing.
    roles.worker!.turns = 99;
    expect(tracker.roleUsage().worker?.turns).toBe(2);
  });

  it('trips each ceiling and reports the first in deterministic order', () => {
    const turns = createRunBudgetTracker({ ...UNBOUNDED, maxWorkerTurns: 1 });
    expect(turns.exceededLimit()).toBeUndefined();
    turns.recordModelUsage('worker', USAGE);
    expect(turns.exceededLimit()).toBe('worker_turns');

    const calls = createRunBudgetTracker({ ...UNBOUNDED, maxToolCalls: 2 });
    calls.recordToolCalls(2);
    expect(calls.exceededLimit()).toBeUndefined(); // spendable in full
    calls.recordToolCalls(1);
    expect(calls.exceededLimit()).toBe('tool_calls');

    const tokens = createRunBudgetTracker({ ...UNBOUNDED, maxModelTokens: 150 });
    tokens.recordModelUsage('initializer', USAGE); // 165 > 150
    expect(tokens.exceededLimit()).toBe('model_tokens');

    let nowMs = 1000;
    const wall = createRunBudgetTracker(
      { ...UNBOUNDED, maxWallTimeMs: 500 },
      { now: () => nowMs },
    );
    expect(wall.exceededLimit()).toBeUndefined();
    nowMs = 1500;
    expect(wall.exceededLimit()).toBe('wall_time');
    expect(wall.remainingWallTimeMs()).toBe(0);

    const corrections = createRunBudgetTracker({ ...UNBOUNDED, maxVerifierCorrections: 1 });
    corrections.recordCorrection();
    expect(corrections.correctionsUsed()).toBe(1);
    expect(corrections.exceededLimit()).toBeUndefined();
    corrections.recordCorrection();
    expect(corrections.exceededLimit()).toBe('verifier_corrections');
  });

  it('rejects nonsensical record inputs instead of corrupting totals', () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    expect(() => tracker.recordToolCalls(-1)).toThrow(/integer/);
    expect(() => tracker.recordToolCalls(Number.NaN)).toThrow(/integer/);
    expect(() => tracker.recordToolResultBytes(1.5)).toThrow(/integer/);
  });
});

// The tracker is ONE unresettable whole-run budget shared by initializer,
// worker, and verifier. These tests are about a later checkpoint/resume
// step's needs: capturing that whole-run state and rebuilding a tracker
// that keeps enforcing it — a restart must never refill headroom, wall time
// included.
describe('RunBudgetTracker snapshot/restore', () => {
  it('capture -> restore round-trips role usage, tool calls, tool-result bytes, and corrections', () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    tracker.recordModelUsage('worker', USAGE, 40);
    tracker.recordModelUsage('verifier', USAGE, 25);
    tracker.recordToolCalls(3);
    tracker.recordToolResultBytes(512);
    tracker.recordCorrection();

    const snapshot = captureRunBudgetSnapshot(tracker);
    expect(snapshot.roles).toEqual(tracker.roleUsage());
    expect(snapshot.corrections).toBe(1);

    const restored = createRunBudgetTracker(UNBOUNDED, { restore: snapshot });
    expect(restored.roleUsage()).toEqual(tracker.roleUsage());
    expect(restored.correctionsUsed()).toBe(1);
    expect(restored.workerTurnsUsed()).toBe(1);
    expect(restored.totalModelTokens()).toBe(tracker.totalModelTokens());
  });

  it('restored tool calls keep enforcing their ceiling while result-byte metrics remain monotone', () => {
    const config = { ...UNBOUNDED, maxToolCalls: 5 };
    const tracker = createRunBudgetTracker(config);
    tracker.recordToolCalls(5);
    tracker.recordToolResultBytes(100);
    const snapshot = captureRunBudgetSnapshot(tracker);

    // Exactly at the ceiling, not yet over it — same boundary a live
    // tracker would report.
    const restoredAtCeiling = createRunBudgetTracker(config, { restore: snapshot });
    expect(restoredAtCeiling.exceededLimit()).toBeUndefined();

    const restoredCalls = createRunBudgetTracker(config, { restore: snapshot });
    restoredCalls.recordToolCalls(1);
    expect(restoredCalls.exceededLimit()).toBe('tool_calls');

    const restoredBytes = createRunBudgetTracker(config, { restore: snapshot });
    restoredBytes.recordToolResultBytes(1);
    expect(captureRunBudgetSnapshot(restoredBytes).toolResultBytes).toBe(101);
    expect(restoredBytes.exceededLimit()).toBeUndefined();
  });

  it('restored elapsed wall time is preserved: a near-exhausted snapshot trips wall_time almost immediately', () => {
    let nowMs = 1_000_000;
    const tracker = createRunBudgetTracker(
      { ...UNBOUNDED, maxWallTimeMs: 10_000 },
      { now: () => nowMs },
    );
    nowMs += 9_900; // almost the whole window already spent
    const snapshot = captureRunBudgetSnapshot(tracker);
    expect(snapshot.elapsedWallTimeMs).toBe(9_900);

    // A brand-new process clock, unrelated to the original run's.
    let restoredNowMs = 5_000_000;
    const restored = createRunBudgetTracker(
      { ...UNBOUNDED, maxWallTimeMs: 10_000 },
      { now: () => restoredNowMs, restore: snapshot },
    );
    // The restored tracker reports the SAME elapsed time the snapshot held,
    // even though this process's clock started somewhere else entirely.
    expect(restored.elapsedWallTimeMs()).toBe(9_900);
    expect(restored.exceededLimit()).toBeUndefined();
    expect(restored.remainingWallTimeMs()).toBe(100);

    restoredNowMs += 100; // only 100ms of real new time...
    // ...but 9900 + 100 reaches 10000: the deadline trips exactly,
    // rather than getting a fresh 10s window.
    expect(restored.exceededLimit()).toBe('wall_time');
  });

  it('charges downtime from the durable snapshot time across repeated restores', () => {
    const config = { ...UNBOUNDED, maxWallTimeMs: 10_000 };
    let firstNowMs = 1_000_000;
    const first = createRunBudgetTracker(config, { now: () => firstNowMs });

    firstNowMs = 1_002_000;
    const firstSnapshotAtMs = firstNowMs;
    const firstSnapshot = captureRunBudgetSnapshot(first);
    expect(firstSnapshot.elapsedWallTimeMs).toBe(2_000);

    // The process was absent for 3 seconds. A durable restore counts those
    // seconds instead of resuming at the snapshot's old 2-second duration.
    let secondNowMs = 1_005_000;
    const second = createRunBudgetTracker(config, {
      now: () => secondNowMs,
      restore: firstSnapshot,
      restoreSnapshotAtMs: firstSnapshotAtMs,
    });
    expect(second.elapsedWallTimeMs()).toBe(5_000);

    secondNowMs = 1_006_000;
    const secondSnapshotAtMs = secondNowMs;
    const secondSnapshot = captureRunBudgetSnapshot(second);
    expect(secondSnapshot.elapsedWallTimeMs).toBe(6_000);

    // A second restart still reconstructs the original t=1,000,000 baseline;
    // repeated recovery neither resets nor double-counts elapsed time.
    let thirdNowMs = 1_011_000;
    const third = createRunBudgetTracker(config, {
      now: () => thirdNowMs,
      restore: secondSnapshot,
      restoreSnapshotAtMs: secondSnapshotAtMs,
    });
    expect(third.elapsedWallTimeMs()).toBe(11_000);
    expect(third.exceededLimit()).toBe('wall_time');
  });

  it('fails closed for unusable absolute restore timestamps', () => {
    let nowMs = 10_000;
    const snapshot = captureRunBudgetSnapshot(
      createRunBudgetTracker(UNBOUNDED, { now: () => nowMs }),
    );

    expect(() =>
      createRunBudgetTracker(UNBOUNDED, {
        now: () => nowMs,
        restoreSnapshotAtMs: nowMs,
      }),
    ).toThrow(/requires a RunBudgetSnapshot/);

    for (const invalid of [-1, Number.NaN, Infinity]) {
      expect(() =>
        createRunBudgetTracker(UNBOUNDED, {
          now: () => nowMs,
          restore: snapshot,
          restoreSnapshotAtMs: invalid,
        }),
      ).toThrow(/restoreSnapshotAtMs must be a finite number >= 0/);
    }

    expect(() =>
      createRunBudgetTracker(UNBOUNDED, {
        now: () => nowMs,
        restore: snapshot,
        restoreSnapshotAtMs: nowMs + 1,
      }),
    ).toThrow(/must not be later than the current clock/);
  });

  it('a restored tracker keeps enforcing maxWorkerTurns from the restored count, so a restart cannot refill headroom', () => {
    const config = { ...UNBOUNDED, maxWorkerTurns: 2 };
    const tracker = createRunBudgetTracker(config);
    tracker.recordModelUsage('worker', USAGE);
    const snapshot = captureRunBudgetSnapshot(tracker);

    const restored = createRunBudgetTracker(config, { restore: snapshot });
    expect(restored.workerTurnsUsed()).toBe(1);
    expect(restored.exceededLimit()).toBeUndefined();
    // A fresh tracker would tolerate two calls before tripping; this one,
    // seeded with one already spent, trips on its first new call.
    restored.recordModelUsage('worker', USAGE);
    expect(restored.exceededLimit()).toBe('worker_turns');
  });

  it('a restored tracker keeps enforcing maxVerifierCorrections from the restored count, so a restart cannot refill headroom', () => {
    const config = { ...UNBOUNDED, maxVerifierCorrections: 1 };
    const tracker = createRunBudgetTracker(config);
    tracker.recordCorrection();
    const snapshot = captureRunBudgetSnapshot(tracker);

    const restored = createRunBudgetTracker(config, { restore: snapshot });
    expect(restored.correctionsUsed()).toBe(1);
    expect(restored.exceededLimit()).toBeUndefined();
    restored.recordCorrection();
    expect(restored.exceededLimit()).toBe('verifier_corrections');
  });

  it('rejects a malformed snapshot instead of restoring a budget that under-counts', () => {
    const valid = captureRunBudgetSnapshot(createRunBudgetTracker(UNBOUNDED));
    expect(() =>
      createRunBudgetTracker(UNBOUNDED, { restore: { ...valid, elapsedWallTimeMs: -1 } }),
    ).toThrow(/elapsedWallTimeMs/);
    expect(() =>
      createRunBudgetTracker(UNBOUNDED, { restore: { ...valid, toolCalls: Number.NaN } }),
    ).toThrow(/toolCalls/);
    expect(() =>
      createRunBudgetTracker(UNBOUNDED, { restore: { ...valid, toolResultBytes: Infinity } }),
    ).toThrow(/toolResultBytes/);
    expect(() =>
      createRunBudgetTracker(UNBOUNDED, { restore: { ...valid, corrections: -3 } }),
    ).toThrow(/corrections/);

    const malformedRoles: RunBudgetSnapshot = {
      ...valid,
      roles: {
        worker: {
          turns: -1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          wallClockMs: 0,
        },
      },
    };
    expect(() => createRunBudgetTracker(UNBOUNDED, { restore: malformedRoles })).toThrow(
      /roles\.worker\.turns/,
    );
  });

  it('capture deep-copies role usage so later recording cannot mutate the snapshot', () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    tracker.recordModelUsage('worker', USAGE, 10);
    const snapshot = captureRunBudgetSnapshot(tracker);

    tracker.recordModelUsage('worker', USAGE, 10);

    expect(snapshot.roles.worker?.turns).toBe(1);
    expect(tracker.roleUsage().worker?.turns).toBe(2);
  });
});
