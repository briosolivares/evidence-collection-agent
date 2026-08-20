import { describe, expect, it, vi } from 'vitest';

import { createRunBudgetTracker } from '../../src/run/runBudget.js';
import { createRunDeadline, raceWithRunSignal } from '../../src/run/runDeadline.js';

function budget(maxWallTimeMs: number) {
  return createRunBudgetTracker({
    maxWorkerTurns: Infinity,
    maxToolCalls: Infinity,
    maxModelTokens: Infinity,
    maxWallTimeMs,
  });
}

describe('whole-run deadline', () => {
  it('interrupts a non-cooperative promise with a typed wall-time limit', async () => {
    const deadline = createRunDeadline(budget(10));
    try {
      await expect(
        raceWithRunSignal(() => new Promise<never>(() => undefined), deadline.signal),
      ).rejects.toMatchObject({
        name: 'RoleBudgetExceededError',
        limit: 'wall_time',
      });
    } finally {
      deadline.dispose();
    }
  });

  it('preserves a pre-existing user cancellation instead of relabeling it', async () => {
    const user = new AbortController();
    const reason = new Error('operator stopped the run');
    user.abort(reason);
    const deadline = createRunDeadline(budget(10), user.signal);
    try {
      await expect(
        raceWithRunSignal(() => Promise.resolve('unused'), deadline.signal),
      ).rejects.toBe(reason);
    } finally {
      deadline.dispose();
    }
  });

  it('lets a cooperative abort failure settle before the deadline race', async () => {
    const user = new AbortController();
    const failure = Object.assign(new Error('provider reported its abort'), {
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const operation = new Promise<never>((_resolve, reject) => {
      user.signal.addEventListener('abort', () => reject(failure), {
        once: true,
      });
    });
    const deadline = createRunDeadline(budget(Infinity), user.signal);
    const running = raceWithRunSignal(() => operation, deadline.signal);

    user.abort(new DOMException('cancelled', 'AbortError'));

    await expect(running).rejects.toBe(failure);
    deadline.dispose();
  });

  it('removes its user listener and timer when disposed', () => {
    const user = new AbortController();
    const remove = vi.spyOn(user.signal, 'removeEventListener');
    const deadline = createRunDeadline(budget(60_000), user.signal);

    deadline.dispose();
    deadline.dispose();

    expect(remove).toHaveBeenCalledOnce();
  });
});
