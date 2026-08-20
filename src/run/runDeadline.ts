import {
  RoleBudgetExceededError,
  type RunBudgetTracker,
} from './runBudget.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One absolute deadline shared by every active operation. The signal's
 * reason distinguishes operator cancellation from wall-budget exhaustion. */
export interface RunDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Combine optional user cancellation with the restored run budget's wall
 * deadline. Downtime is already included by the tracker, so a resumed run
 * whose deadline passed is aborted synchronously at construction. */
export function createRunDeadline(
  budget: RunBudgetTracker,
  userSignal?: AbortSignal,
): RunDeadline {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  const abortFromUser = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(userSignal?.reason);
    }
  };

  const abortFromWallTime = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new RoleBudgetExceededError('wall_time'));
    }
  };

  const scheduleWallDeadline = (): void => {
    if (disposed || controller.signal.aborted) return;
    const remainingMs = budget.remainingWallTimeMs();
    if (remainingMs === Infinity) return;
    if (remainingMs <= 0) {
      abortFromWallTime();
      return;
    }
    timer = setTimeout(
      scheduleWallDeadline,
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  };

  if (userSignal?.aborted === true) {
    abortFromUser();
  } else {
    userSignal?.addEventListener('abort', abortFromUser, { once: true });
    scheduleWallDeadline();
  }

  return {
    signal: controller.signal,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      userSignal?.removeEventListener('abort', abortFromUser);
    },
  };
}

/** Race an operation even when it ignores AbortSignal. Operation handlers are
 * installed before the abort handler and abort rejection is deferred by one
 * microtask, so a cooperative provider can settle with billable usage first;
 * its caller then persists that usage before enforcing the signal reason. A
 * genuinely non-cooperative promise is detached safely without an unhandled
 * late rejection. */
export function raceWithRunSignal<T>(
  startOperation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);

  let operation: Promise<T>;
  try {
    operation = startOperation();
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal === undefined) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortImmediate: NodeJS.Immediate | undefined;

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (abortImmediate !== undefined) clearImmediate(abortImmediate);
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => {
      abortImmediate = setImmediate(() => {
        finish(() => reject(signal.reason));
      });
    };

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
