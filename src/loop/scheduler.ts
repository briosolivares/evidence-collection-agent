import { executeToolCall, type ToolCall, type ToolCallResult } from '../tools/pipeline.js';
import {
  accessesConflict,
  EXCLUSIVE_ACCESS,
  LEGACY_READ_ACCESS,
  type ToolAccess,
  type ToolCtx,
  type ToolDef,
  type ToolRegistry,
} from '../tools/registry.js';

/** Maximum tool calls in flight at once. Access safety says two calls CAN
 * overlap; it does not say a dozen network or browser operations should. */
export const MAX_CONCURRENT_CALLS = 5;

/**
 * One call with everything scheduling needs decided up front: its tool, its
 * validated input, and what it touches.
 *
 * The ordering matters. Access is derived from VALIDATED input, so every call
 * is parsed before any call runs — which is what makes "an invalid response
 * causes zero side effects" true rather than aspirational. Deciding access
 * from raw model input would mean trusting a field the tool has not checked.
 */
export interface ValidatedToolCall {
  call: ToolCall;
  index: number;
  /** Absent when the tool is unknown; the pipeline reports that per-call. */
  tool?: ToolDef;
  /** The parsed input, when the schema accepted it. */
  input?: unknown;
  /** What this call touches. EXCLUSIVE_ACCESS whenever anything is unknown. */
  access: ToolAccess;
  /** Set when validation failed, so the call is answered without executing. */
  validationError?: string;
}

/**
 * Parse and validate every call, then derive its access.
 *
 * Nothing executes here. A call whose tool is unknown, whose input fails its
 * schema, or whose `getAccess` throws is marked EXCLUSIVE and carries its
 * error forward — the conservative reading in all three cases, since a call we
 * cannot classify must never run beside another.
 */
export function validateToolCallsForScheduling(
  calls: readonly ToolCall[],
  registry: ToolRegistry,
): ValidatedToolCall[] {
  return calls.map((call, index) => {
    const tool = registry.get(call.name);
    if (tool === undefined) {
      // Unknown tool: the pipeline produces the structured unknown_tool error.
      return { call, index, access: EXCLUSIVE_ACCESS };
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        call,
        index,
        tool,
        access: EXCLUSIVE_ACCESS,
        validationError: parsed.error.message,
      };
    }

    if (tool.getAccess === undefined) {
      // Migration path: a tool that has not declared access falls back to the
      // readOnly flag. Read-only tools may still overlap each other, which
      // preserves today's parallelism; anything else runs alone.
      return {
        call,
        index,
        tool,
        input: parsed.data,
        access: tool.readOnly ? LEGACY_READ_ACCESS : EXCLUSIVE_ACCESS,
      };
    }

    try {
      return { call, index, tool, input: parsed.data, access: tool.getAccess(parsed.data) };
    } catch {
      // A buggy declaration degrades to serial, never to unsafe parallelism.
      return { call, index, tool, input: parsed.data, access: EXCLUSIVE_ACCESS };
    }
  });
}

/**
 * Group validated calls into consecutive runs that may execute concurrently.
 *
 * Order is preserved: a call joins the current group only if it conflicts with
 * NO member of it. The first conflict closes the group. That keeps the
 * long-standing guarantee that a call requested after a write observes that
 * write — a read hoisted ahead of the write it was meant to observe would hand
 * the model a stale answer — while letting genuinely disjoint work overlap.
 */
export function groupConcurrentCalls(
  validated: readonly ValidatedToolCall[],
): ValidatedToolCall[][] {
  const groups: ValidatedToolCall[][] = [];
  for (const entry of validated) {
    const current = groups[groups.length - 1];
    if (
      current !== undefined &&
      current.every((member) => !accessesConflict(member.access, entry.access))
    ) {
      current.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

/**
 * Execute one model response's tool calls, overlapping only what provably
 * cannot race.
 *
 * Contract:
 *  - Every call is validated BEFORE any call executes, so a response
 *    containing an invalid call still produces zero side effects from it.
 *  - Calls overlap only when neither writes a key the other reads or writes
 *    (see accessesConflict). Same-page actions and same-table updates
 *    serialize; independent pages, tables, files, and origins overlap.
 *  - At most MAX_CONCURRENT_CALLS run at once.
 *  - Results are committed in the model's original call order regardless of
 *    completion order, so the model-visible sequence is deterministic even
 *    though timing is not.
 *  - A failing call yields its structured error in its own slot without
 *    aborting the others; this never throws.
 */
export async function scheduleToolCalls(
  calls: readonly ToolCall[],
  registry: ToolRegistry,
  ctx: ToolCtx,
): Promise<ToolCallResult[]> {
  const validated = validateToolCallsForScheduling(calls, registry);
  const buffered = new Array<ToolCallResult>(calls.length);
  const slots = new Semaphore(MAX_CONCURRENT_CALLS);

  for (const group of groupConcurrentCalls(validated)) {
    await Promise.all(
      group.map(async (entry) => {
        await slots.acquire();
        try {
          // Re-running the pipeline (which re-validates) keeps ONE validation
          // authority rather than two that could disagree. The duplicate parse
          // is cheap next to any real tool's work, and a second opinion about
          // whether input is valid is exactly the bug worth avoiding.
          buffered[entry.index] = await executeToolCall(registry, entry.call, ctx);
        } finally {
          slots.release();
        }
      }),
    );
  }

  return commitToolResultsInCallOrder(validated, buffered);
}

/**
 * Return results in the model's original call order.
 *
 * Buffering and committing separately is what makes out-of-order completion
 * unobservable: slot i always answers call i, whatever finished first.
 */
export function commitToolResultsInCallOrder(
  validated: readonly ValidatedToolCall[],
  buffered: readonly ToolCallResult[],
): ToolCallResult[] {
  return validated
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((entry) => buffered[entry.index]!);
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
