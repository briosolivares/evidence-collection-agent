import { executeToolCall, type ToolCall, type ToolCallResult } from '../tools/pipeline.js';
import type { ToolCtx, ToolRegistry } from '../tools/registry.js';

/** Maximum number of read-only tool calls in flight at once. Parallel reads
 * buy speed at zero correctness risk, but an uncapped burst would spike
 * resource use — the design (five mechanisms, item 5) fixes the cap at 5. */
export const MAX_CONCURRENT_READS = 5;

/**
 * Execute one model response's tool calls: read-only tools in parallel,
 * state-changing tools one at a time, results in request order.
 *
 * Scheduling contract — request order is preserved at batch granularity:
 * consecutive read-only calls (per the registry's `readOnly` flag) form one
 * batch and run concurrently with at most MAX_CONCURRENT_READS in flight;
 * state-changing calls run strictly one at a time; batches execute in
 * request order, one after another. A state-changing call is therefore a
 * barrier: every call requested before it finishes before it starts, and no
 * call requested after it starts until it finishes. (A read requested after
 * a write is usually meant to observe that write's effect — think `click`
 * then `inspect_page` — so hoisting it ahead of the write would hand the
 * model a stale observation. Claude Code interleaves the same way.) A call
 * naming an unknown tool is scheduled as state-changing — the conservative
 * guess — and the pipeline reports its structured unknown-tool error.
 *
 * @param calls - the tool invocations of one model response, in request order
 * @param registry - the tools available to this run; each call's `readOnly`
 *   flag decides how it is scheduled
 * @param ctx - per-run context passed through to every executor
 * @returns one result per call, positionally matching `calls` regardless of
 *   completion order (the API requires each tool_result to answer its
 *   tool_use). A failing call yields its structured error result in its
 *   slot without aborting the other calls; like the pipeline, this never
 *   throws.
 */
export async function scheduleToolCalls(
  calls: readonly ToolCall[],
  registry: ToolRegistry,
  ctx: ToolCtx,
): Promise<ToolCallResult[]> {
  // Results land by original index, never by completion order — parallel
  // reads finish in any order, but slot i must always answer call i.
  const results = new Array<ToolCallResult>(calls.length);
  const readSlots = new Semaphore(MAX_CONCURRENT_READS);

  for (const batch of partitionCalls(calls, registry)) {
    if (batch.readOnly) {
      await Promise.all(
        batch.entries.map(async ({ call, index }) => {
          await readSlots.acquire();
          try {
            results[index] = await executeToolCall(registry, call, ctx);
          } finally {
            readSlots.release();
          }
        }),
      );
    } else {
      for (const { call, index } of batch.entries) {
        results[index] = await executeToolCall(registry, call, ctx);
      }
    }
  }

  return results;
}

/** One call paired with its position in the original request. */
interface IndexedCall {
  call: ToolCall;
  index: number;
}

/** A maximal run of consecutive same-kind calls: read-only batches execute
 * concurrently, state-changing batches one entry at a time. */
interface Batch {
  readOnly: boolean;
  entries: IndexedCall[];
}

/** Split the calls into maximal consecutive same-kind batches, preserving
 * request order. A call whose tool is not in the registry counts as
 * state-changing (conservative: never parallelize what we can't classify). */
function partitionCalls(calls: readonly ToolCall[], registry: ToolRegistry): Batch[] {
  const batches: Batch[] = [];
  calls.forEach((call, index) => {
    const readOnly = registry.get(call.name)?.readOnly ?? false;
    const lastBatch = batches[batches.length - 1];
    if (lastBatch !== undefined && lastBatch.readOnly === readOnly) {
      lastBatch.entries.push({ call, index });
    } else {
      batches.push({ readOnly, entries: [{ call, index }] });
    }
  });
  return batches;
}

/** A counting semaphore: at most `slots` concurrent holders; a freed slot
 * goes to the longest-waiting acquirer (FIFO), so calls start in the order
 * they asked. */
class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.free = slots;
  }

  /** Resolves once a slot is held; pair every acquire with one release. */
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((grant) => this.waiters.push(grant));
  }

  /** Return a held slot, handing it straight to the next waiter if any. */
  release(): void {
    const nextWaiter = this.waiters.shift();
    if (nextWaiter !== undefined) {
      nextWaiter();
    } else {
      this.free += 1;
    }
  }
}
