import { afterEach, describe, expect, it, vi } from 'vitest';

import { settleWithin } from '../../src/browser/boundedSettlement.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('settleWithin', () => {
  it('classifies fulfillment and clears the unused deadline', async () => {
    vi.useFakeTimers();

    await expect(settleWithin(Promise.resolve(), 1_000)).resolves.toBe('fulfilled');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies rejection without propagating it', async () => {
    vi.useFakeTimers();

    await expect(settleWithin(Promise.reject(new Error('cleanup failed')), 1_000)).resolves.toBe(
      'rejected',
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns when the deadline wins a still-pending effect', async () => {
    vi.useFakeTimers();
    const settlement = settleWithin(new Promise<never>(() => undefined), 25);

    await vi.advanceTimersByTimeAsync(25);

    await expect(settlement).resolves.toBe('timed_out');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes an effect that rejects after timing out', async () => {
    vi.useFakeTimers();
    let rejectEffect: ((reason: unknown) => void) | undefined;
    const effect = new Promise<never>((_resolve, reject) => {
      rejectEffect = reject;
    });
    const then = vi.spyOn(effect, 'then');
    const settlement = settleWithin(effect, 25);

    expect(then).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    await vi.advanceTimersByTimeAsync(25);
    await expect(settlement).resolves.toBe('timed_out');

    rejectEffect!(new Error('late cleanup failure'));
    await Promise.resolve();
  });
});
