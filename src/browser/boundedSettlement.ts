export type BoundedSettlement = 'fulfilled' | 'rejected' | 'timed_out';

export interface DeadlineRaceOptions {
  /** Hard bound on how long the caller waits for the effect. */
  timeoutMs: number;
  /** Error the race rejects with when the deadline fires first. */
  onTimeout: () => Error;
  /** Optional caller cancellation. The race rejects with the signal's exact
   * reason, checked both before the effect starts and while it is racing. */
  signal?: AbortSignal;
  /** Per-site error policy applied to a synchronous throw from `start` and to
   * the effect's rejection (redaction/wrapping). Defaults to identity. Not
   * applied to the timeout error or to an abort reason. */
  mapError?: (error: unknown) => unknown;
}

/**
 * Run an effect against a hard deadline (and optional abort signal) without
 * abandoning it unobserved: the effect's handlers stay attached, so a late
 * settlement after the caller has been released can never become an unhandled
 * rejection. Containment of the still-running effect stays with the caller.
 */
export function raceWithDeadline<T>(
  start: () => Promise<T>,
  options: DeadlineRaceOptions,
): Promise<T> {
  const { timeoutMs, onTimeout, signal } = options;
  const mapError = options.mapError ?? ((error: unknown) => error);
  if (signal?.aborted) return Promise.reject(signal.reason);

  let effect: Promise<T>;
  try {
    effect = start();
  } catch (error) {
    return Promise.reject(mapError(error));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => reject(onTimeout())), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    effect.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(mapError(error))),
    );
  });
}

/**
 * Race an effect against caller cancellation with containment-first ordering:
 * once the signal fires, the caller-supplied containment is established BEFORE
 * the race rejects with the abort reason, and a provider promise settling at
 * the same boundary loses to the abort. This ordering is load-bearing for
 * browser preparation — a cancelled step must never release its caller while
 * the aborted provider effect is still unquarantined — so it is a distinct
 * variant rather than an option on {@link raceWithDeadline}.
 */
export function raceWithAbortContainment<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  containOnAbort: () => void | Promise<void>,
): Promise<T> {
  if (signal === undefined) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborting = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => {
      if (aborting || settled) return;
      aborting = true;
      void Promise.resolve()
        .then(containOnAbort)
        .then(
          () => finish(() => reject(signal.reason)),
          (error) => finish(() => reject(error)),
        );
    };

    operation.then(
      (value) => {
        if (!aborting) finish(() => resolve(value));
      },
      (error) => {
        if (!aborting) finish(() => reject(error));
      },
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Observe an effect's eventual rejection while bounding how long its caller waits. */
export async function settleWithin(
  effect: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedSettlement> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      effect.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
