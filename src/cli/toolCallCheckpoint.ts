/**
 * Per-tool-call checkpointing.
 *
 * Owns {@link createToolCallCheckpointHooks}, the `ToolCallLifecycleHooks`
 * implementation that lets `runHarnessCycles` (see harnessCycles.ts) save a
 * checkpoint before every state-changing tool call starts and after every one
 * finishes, not just once per worker turn. Split into its own file because it
 * is a self-contained two-phase construction (built inert, then `bind`-ed once
 * the session it reads from exists) with no other reason to live beside the
 * cycle loop that uses it.
 */
import type { RunCheckpointV1 } from '../run/runCheckpointStore.js';
import type { ToolCall } from '../tools/pipeline.js';
import type { ToolCallLifecycleHooks } from '../loop/scheduler.js';
import type { WorkerSession } from '../loop/workerSession.js';

/**
 * One tool call as a checkpoint records it, keyed by the model's own call id.
 */
type CheckpointedToolCall = NonNullable<RunCheckpointV1['pendingTurn']>['toolCalls'][number];

/**
 * Per-tool-call checkpointing, as a `ToolCallLifecycleHooks` the WorkerSession
 * can be built with.
 *
 * Two-phase construction is forced by an ordering the code cannot avoid: the
 * hooks must exist before the `WorkerSession` (they are one of its deps), but
 * they need that same session to read the turn number and the assistant
 * message a batch belongs to. So the hooks are created inert and `bind` is
 * called once the session exists. Before binding, every hook is a no-op,
 * which is why an unbound instance is safe to install rather than something
 * to guard against at each call site.
 */
export interface ToolCallCheckpointHooks {
  hooks: ToolCallLifecycleHooks;
  /** Supply the session and the save this run should use. Called once, right
   * after the session is constructed. */
  bind(target: {
    session: WorkerSession;
    save: (pendingTurn: NonNullable<RunCheckpointV1['pendingTurn']>) => Promise<void>;
  }): void;
}

export function createToolCallCheckpointHooks(): ToolCallCheckpointHooks {
  let target:
    | {
        session: WorkerSession;
        save: (pendingTurn: NonNullable<RunCheckpointV1['pendingTurn']>) => Promise<void>;
      }
    | undefined;

  // The batch currently being observed. Reset whenever the session's turn
  // count moves, which is how a new turn's first hook is distinguished from a
  // later call in the same turn: `runWorkerTurn` increments `turnCount` before
  // it schedules anything, so the count is a reliable batch identity without
  // the session having to announce batch boundaries.
  let openTurn: number | undefined;
  let observed: CheckpointedToolCall[] = [];

  /** The batch as it currently stands, ready to persist. Records only the
   * calls observed SO FAR, not the model's full batch: the hooks learn about
   * a call when it starts (state-changing) or settles (any), and never receive
   * the batch as a whole. A checkpoint that listed calls it had not seen would
   * be inventing detail. */
  const pendingTurn = (
    session: WorkerSession,
  ): NonNullable<RunCheckpointV1['pendingTurn']> => ({
    turnNumber: session.state.turnCount,
    assistantMessage: session.state.messages.at(-1),
    toolCalls: [...observed],
  });

  /** Record a call's current phase. Returns false when the call is not one
   * this batch is tracking, which is how a read-only call is filtered out of
   * the settle path — see `afterCallResult`. */
  const track = (
    session: WorkerSession,
    call: ToolCall,
    executionStatus: CheckpointedToolCall['executionStatus'],
    result?: unknown,
  ): boolean => {
    if (openTurn !== session.state.turnCount) {
      openTurn = session.state.turnCount;
      observed = [];
    }
    const existing = observed.findIndex((seen) => seen.request.id === call.id);
    if (existing === -1 && executionStatus !== 'running') return false;
    const entry: CheckpointedToolCall = {
      request: { id: call.id, name: call.name, input: call.input },
      executionStatus,
      ...(result === undefined ? {} : { result }),
    };
    if (existing === -1) {
      observed.push(entry);
    } else {
      observed[existing] = entry;
    }
    return true;
  };

  return {
    hooks: {
      // Propagates a save failure on purpose, which fails this one call
      // without running it (see scheduleToolCalls). If the runtime cannot
      // record that a state-changing call is about to happen, running it
      // anyway would leave a resume unable to tell whether it did.
      async beforeStateChangingCall(call): Promise<void> {
        if (target === undefined) return;
        track(target.session, call, 'running');
        await target.save(pendingTurn(target.session));
      },

      // Fires for EVERY call, read-only ones included, so it saves only for
      // calls the batch is already tracking — i.e. the state-changing ones
      // the hook above recorded as 'running'. A read has no side effect to
      // warn a resumed model about, and every checkpoint write serializes the
      // whole conversation, so saving after each read would multiply this
      // run's checkpoint I/O to record nothing anyone can act on.
      //
      // Best-effort, deliberately unlike the hook above: this one runs after
      // the tool already did its work, and `scheduleToolCalls` turns a throw
      // here into an error result that REPLACES that work's real result. A
      // failed checkpoint write must not destroy a successful tool call — the
      // run continues with a slightly staler checkpoint instead.
      async afterCallResult(call, result): Promise<void> {
        if (target === undefined) return;
        if (!track(target.session, call, 'finished', result)) return;
        try {
          await target.save(pendingTurn(target.session));
        } catch {
          // Intentionally swallowed; see above.
        }
      },
    },

    bind(next): void {
      target = next;
    },
  };
}
