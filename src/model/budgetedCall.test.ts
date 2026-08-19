import { describe, expect, it, vi } from 'vitest';

import type { Message } from './messages.js';
import {
  ModelGenerationFailedError,
  type ModelDriver,
} from './modelDriver.js';
import { createRunBudgetTracker } from '../run/runBudget.js';
import { createRunDeadline } from '../agent/runDeadline.js';
import {
  RoleBudgetExceededError,
  createBudgetedCallModel,
} from './budgetedCall.js';

const messages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'verify this run' }] },
];

function budget() {
  return createRunBudgetTracker({
    maxWorkerTurns: Infinity,
    maxToolCalls: Infinity,
    maxModelTokens: Infinity,
    maxWallTimeMs: Infinity,
    maxVerifierCorrections: Infinity,
  });
}

describe('createBudgetedCallModel', () => {
  it('returns accepted-attempt usage while charging aggregate known usage', async () => {
    const tracker = budget();
    const response = {
      content: [{ type: 'text' as const, text: 'verified' }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const generate = vi.fn(async () => ({
      response,
      stopReason: 'end_turn' as const,
      attempts: 2,
      usage: { input_tokens: 15, output_tokens: 6 },
    }));

    const call = createBudgetedCallModel({
      model: { generate },
      budget: tracker,
      role: 'verifier',
    });

    await expect(call(messages)).resolves.toBe(response);
    expect(tracker.roleUsage().verifier).toMatchObject({
      turns: 1,
      inputTokens: 15,
      outputTokens: 6,
    });
  });

  it('charges a fatal call carrying known usage before preserving the failure', async () => {
    const tracker = budget();
    const failure = new ModelGenerationFailedError(
      new Error('replacement failed'),
      { input_tokens: 8, output_tokens: 3 },
    );
    const model: ModelDriver = {
      generate: vi.fn(async () => {
        throw failure;
      }),
    };
    const call = createBudgetedCallModel({
      model,
      budget: tracker,
      role: 'initializer',
    });

    await expect(call(messages)).rejects.toBe(failure);
    expect(tracker.roleUsage().initializer).toMatchObject({
      turns: 1,
      inputTokens: 8,
      outputTokens: 3,
    });
  });

  it('passes cancellation and attempt events to the strict driver unchanged', async () => {
    const tracker = budget();
    const controller = new AbortController();
    const onEvent = vi.fn();
    const model: ModelDriver = {
      generate: vi.fn(async (options) => {
        expect(options.signal).toBe(controller.signal);
        expect(options.onEvent).toBe(onEvent);
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }),
    };
    const call = createBudgetedCallModel({
      model,
      budget: tracker,
      role: 'verifier',
      signal: controller.signal,
      onEvent,
    });

    await expect(call(messages)).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker.roleUsage().verifier).toBeUndefined();
  });

  it('stops a private role loop before another call after a non-worker budget expires', async () => {
    const tracker = createRunBudgetTracker({
      ...budget().config,
      maxModelTokens: 1,
    });
    tracker.recordModelUsage('initializer', { input_tokens: 2, output_tokens: 0 });
    const generate = vi.fn();
    const call = createBudgetedCallModel({
      model: { generate },
      budget: tracker,
      role: 'verifier',
    });

    await expect(call(messages)).rejects.toMatchObject({
      name: 'RoleBudgetExceededError',
      limit: 'model_tokens',
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('charges a completed call but refuses its response when that call crosses budget', async () => {
    const tracker = createRunBudgetTracker({
      ...budget().config,
      maxModelTokens: 5,
    });
    const response = {
      content: [{ type: 'text' as const, text: 'verified' }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 3, output_tokens: 3 },
    };
    const call = createBudgetedCallModel({
      model: {
        generate: vi.fn(async () => ({
          response,
          stopReason: 'end_turn' as const,
          attempts: 1,
          usage: response.usage,
        })),
      },
      budget: tracker,
      role: 'verifier',
    });

    await expect(call(messages)).rejects.toBeInstanceOf(
      RoleBudgetExceededError,
    );
    expect(tracker.totalModelTokens()).toBe(6);
  });

  it('awaits the durable accounting hook before enforcing a crossed limit', async () => {
    const tracker = createRunBudgetTracker({
      ...budget().config,
      maxModelTokens: 1,
    });
    const observedTokens: number[] = [];
    const response = {
      content: [{ type: 'text' as const, text: 'over budget' }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 2, output_tokens: 1 },
    };
    const call = createBudgetedCallModel({
      model: {
        generate: vi.fn(async () => ({
          response,
          stopReason: 'end_turn' as const,
          attempts: 1,
          usage: response.usage,
        })),
      },
      budget: tracker,
      role: 'verifier',
      afterAttemptSettled: async () => {
        observedTokens.push(tracker.totalModelTokens());
      },
    });

    await expect(call(messages)).rejects.toMatchObject({
      name: 'RoleBudgetExceededError',
      limit: 'model_tokens',
    });
    expect(observedTokens).toEqual([3]);
  });

  it('allows verification after the worker uses its final permitted turn', async () => {
    const tracker = createRunBudgetTracker({
      ...budget().config,
      maxWorkerTurns: 1,
    });
    tracker.recordModelUsage('worker', { input_tokens: 1, output_tokens: 1 });
    const response = {
      content: [{ type: 'text' as const, text: 'verified' }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const call = createBudgetedCallModel({
      model: {
        generate: vi.fn(async () => ({
          response,
          stopReason: 'end_turn' as const,
          attempts: 1,
          usage: response.usage,
        })),
      },
      budget: tracker,
      role: 'verifier',
    });

    await expect(call(messages)).resolves.toBe(response);
  });

  it('charges a completed response but never accepts it after cancellation wins the boundary race', async () => {
    const tracker = budget();
    const controller = new AbortController();
    const response = {
      content: [{ type: 'text' as const, text: 'verified' }],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 4, output_tokens: 1 },
    };
    const call = createBudgetedCallModel({
      model: {
        generate: vi.fn(async () => {
          controller.abort();
          return {
            response,
            stopReason: 'end_turn' as const,
            attempts: 1,
            usage: response.usage,
          };
        }),
      },
      budget: tracker,
      role: 'verifier',
      signal: controller.signal,
    });

    await expect(call(messages)).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracker.totalModelTokens()).toBe(5);
  });

  it('persists provider-reported usage before classifying deadline exhaustion', async () => {
    const tracker = createRunBudgetTracker({
      ...budget().config,
      maxWallTimeMs: 10,
    });
    const deadline = createRunDeadline(tracker);
    const accounting = vi.fn(async () => undefined);
    const failure = new ModelGenerationFailedError(
      new Error('provider stopped at deadline'),
      { input_tokens: 7, output_tokens: 2 },
    );
    const call = createBudgetedCallModel({
      model: {
        generate: vi.fn(async (options) =>
          new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(failure), {
              once: true,
            });
          })),
      },
      budget: tracker,
      role: 'verifier',
      signal: deadline.signal,
      afterAttemptSettled: accounting,
    });

    try {
      await expect(call(messages)).rejects.toMatchObject({
        name: 'RoleBudgetExceededError',
        limit: 'wall_time',
      });
      expect(tracker.totalModelTokens()).toBe(9);
      expect(accounting).toHaveBeenCalledOnce();
    } finally {
      deadline.dispose();
    }
  });
});
