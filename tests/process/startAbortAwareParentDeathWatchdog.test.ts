import { afterEach, describe, expect, it, vi } from 'vitest';

import * as parentDeathWatchdogModule from '../../src/process/parentDeathWatchdog.js';
import { startAbortAwareParentDeathWatchdog } from '../../src/process/startAbortAwareParentDeathWatchdog.js';

function fakeWatchdog(): parentDeathWatchdogModule.ParentDeathWatchdog {
  return {
    arm: vi.fn(async () => undefined),
    disarm: vi.fn(async () => undefined),
    onFailure: vi.fn(() => () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startAbortAwareParentDeathWatchdog', () => {
  it('does not start a watchdog for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog');

    await expect(startAbortAwareParentDeathWatchdog(controller.signal)).resolves.toEqual({
      kind: 'cancelled',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('disarms a watchdog whose startup finishes after cancellation', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const watchdog = fakeWatchdog();
    let finishStart: ((value: parentDeathWatchdogModule.ParentDeathWatchdog) => void) | undefined;
    vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );

    const started = startAbortAwareParentDeathWatchdog(controller.signal);
    controller.abort();
    finishStart!(watchdog);

    await expect(started).resolves.toEqual({ kind: 'cancelled' });
    expect(watchdog.disarm).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('returns a successfully started watchdog without disarming it', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const watchdog = fakeWatchdog();
    vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog').mockResolvedValue(watchdog);

    await expect(startAbortAwareParentDeathWatchdog(controller.signal)).resolves.toEqual({
      kind: 'started',
      watchdog,
    });
    expect(watchdog.disarm).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('returns startup failure after removing the abort listener', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const failure = new parentDeathWatchdogModule.ParentDeathWatchdogError('startup failed');
    vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog').mockRejectedValue(failure);

    await expect(startAbortAwareParentDeathWatchdog(controller.signal)).resolves.toEqual({
      kind: 'start_failed',
      error: failure,
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('propagates disarm failure after cancellation during startup', async () => {
    const controller = new AbortController();
    const failure = new parentDeathWatchdogModule.ParentDeathWatchdogError('disarm failed');
    const watchdog = fakeWatchdog();
    vi.mocked(watchdog.disarm).mockRejectedValue(failure);
    let finishStart: ((value: parentDeathWatchdogModule.ParentDeathWatchdog) => void) | undefined;
    vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );

    const started = startAbortAwareParentDeathWatchdog(controller.signal);
    controller.abort();
    finishStart!(watchdog);

    await expect(started).rejects.toBe(failure);
  });
});
