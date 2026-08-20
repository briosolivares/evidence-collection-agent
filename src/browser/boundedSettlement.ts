export type BoundedSettlement = 'fulfilled' | 'rejected' | 'timed_out';

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
