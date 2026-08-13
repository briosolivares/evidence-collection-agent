import { describe, expect, it } from 'vitest';

import type { Message, ModelResponse } from '../loop/messages.js';
import { ModelResponseRejectedError } from '../model/modelDriver.js';
import {
  createRunBudgetTracker,
  validateRunBudgetConfig,
  withBudgetAccounting,
  type RunBudgetConfig,
} from './runBudget.js';

const UNBOUNDED: RunBudgetConfig = {
  maxWorkerTurns: Infinity,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxToolResultBytes: Infinity,
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
        maxToolResultBytes: 0,
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
    ['maxToolResultBytes fractional', { maxToolResultBytes: 10.5 }],
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

    const bytes = createRunBudgetTracker({ ...UNBOUNDED, maxToolResultBytes: 10 });
    bytes.recordToolResultBytes(11);
    expect(bytes.exceededLimit()).toBe('tool_result_bytes');

    let nowMs = 1000;
    const wall = createRunBudgetTracker(
      { ...UNBOUNDED, maxWallTimeMs: 500 },
      { now: () => nowMs },
    );
    expect(wall.exceededLimit()).toBeUndefined();
    nowMs = 1501;
    expect(wall.exceededLimit()).toBe('wall_time');

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

describe('withBudgetAccounting', () => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }];

  it('charges accepted responses to the given role', async () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    const response: ModelResponse = {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: USAGE,
    };
    const wrapped = withBudgetAccounting(async () => response, tracker, 'verifier');

    await expect(wrapped(messages)).resolves.toBe(response);
    expect(tracker.roleUsage().verifier).toMatchObject({ turns: 1, inputTokens: 100 });
  });

  it('still charges a rejected response before the rejection propagates', async () => {
    const tracker = createRunBudgetTracker(UNBOUNDED);
    const rejection = new ModelResponseRejectedError(
      'refusal',
      'scripted refusal',
      'feedback',
      USAGE,
    );
    const wrapped = withBudgetAccounting(
      async () => {
        throw rejection;
      },
      tracker,
      'initializer',
    );

    await expect(wrapped(messages)).rejects.toBe(rejection);
    expect(tracker.roleUsage().initializer).toMatchObject({ turns: 1, outputTokens: 50 });
  });
});
