import { type ParentDeathWatchdog, startParentDeathWatchdog } from './parentDeathWatchdog.js';

export type AbortAwareParentDeathWatchdogStart =
  | { kind: 'started'; watchdog: ParentDeathWatchdog }
  | { kind: 'cancelled' }
  | { kind: 'start_failed'; error: unknown };

/**
 * Start the parent-death watchdog without letting cancellation race past its
 * startup. An abort before or during startup returns cancelled, after first
 * disarming any watcher whose startup completed. Startup failure is returned
 * separately so each runner can preserve its own public error policy; a
 * disarm failure still rejects.
 */
export async function startAbortAwareParentDeathWatchdog(
  signal?: AbortSignal,
): Promise<AbortAwareParentDeathWatchdogStart> {
  const isAborted = (): boolean => signal?.aborted === true;
  if (isAborted()) return { kind: 'cancelled' };

  let abortedDuringStart = false;
  const onAbort = (): void => {
    abortedDuringStart = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let watchdog: ParentDeathWatchdog;
  try {
    try {
      watchdog = await startParentDeathWatchdog();
    } catch (error) {
      return { kind: 'start_failed', error };
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (abortedDuringStart || isAborted()) {
    await watchdog.disarm();
    return { kind: 'cancelled' };
  }
  return { kind: 'started', watchdog };
}
