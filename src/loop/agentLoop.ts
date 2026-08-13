import { createRunBudgetTracker } from '../run/runBudget.js';
import {
  createWorkerSession,
  recordWorkerSessionCrash,
  runWorkerCycle,
  writeWorkerSessionMetrics,
  type WorkerBudgetReason,
  type WorkerSessionDeps,
  type WorkerSessionState,
} from './workerSession.js';

// Compatibility wrapper for the judge-less path: one worker cycle behind
// the historical runAgentLoop signature. The loop machinery itself —
// turns, tool scheduling, transcript, batch caps, rejection handling,
// metrics — lives in workerSession.ts, where the verification harness
// drives it as one persistent session across correction cycles. This
// wrapper creates a session, advances it through a single cycle, and maps
// the terminal state onto the historical LoopResult/metrics contract.

export {
  MAX_PROTOCOL_CORRECTIONS_PER_RUN,
  METRICS_FILENAME,
  type RunMetrics,
} from './workerSession.js';

/** The loop's memory of a run (kept for compatibility; see
 * WorkerSessionState — the shapes are identical). */
export type State = WorkerSessionState;

/** Everything external the loop touches — see WorkerSessionDeps. */
export type LoopDeps = WorkerSessionDeps;

/**
 * The run's hard guards. A finite maxTurns bounds the turn count outright;
 * maxContextTokens bounds how large any single request may grow — and
 * because the conversation grows every turn, the context ceiling still
 * guarantees termination when maxTurns is Infinity. Boundary semantics are
 * unchanged from the original loop: a run may *complete* on the final
 * allowed turn; guards are checked after tool execution; the context guard
 * measures the request the model just answered.
 */
export interface LoopConfig {
  /** Maximum number of model calls (turns); an integer >= 1, or Infinity. */
  maxTurns: number;
  /** Per-request context ceiling, >= 0 (see WorkerSessionConfig). */
  maxContextTokens: number;
}

/** Which guard ended a budget_exceeded run. If several trip after the same
 * turn, max_turns is reported. */
export type BudgetReason = WorkerBudgetReason;

/**
 * How a run ended. `completed`: the model responded without tool calls;
 * `finalText` is that response's text. `budget_exceeded`: a guard ended
 * the run before the model finished; `reason` names the guard.
 */
export type LoopResult =
  | { status: 'completed'; finalText: string }
  | { status: 'budget_exceeded'; reason: BudgetReason };

/**
 * Run one worker cycle to completion behind the historical contract: ask
 * the model, execute any tools it requests, feed the results back, repeat
 * — until the model responds without tool calls or a guard trips. See
 * runWorkerTurn (workerSession.ts) for the full per-turn semantics: this
 * wrapper adds nothing beyond config validation, LoopResult mapping, and
 * the historical metrics/crash bookkeeping (metrics.json on every ending,
 * run_error + failed metrics on a crash, no bookkeeping at all on an
 * AbortError).
 *
 * @param taskText - the user's task, sent as the conversation's first message
 * @param deps - the loop's only I/O surface; deps.runDir must be an
 *   existing run directory with an initialized manifest
 * @param config - termination guards; throws before any model call if
 *   maxTurns is neither an integer >= 1 nor Infinity, or maxContextTokens
 *   is negative or NaN
 * @returns the run's outcome; by return time the transcript holds the
 *   run's full event sequence and metrics.json its totals
 */
export async function runAgentLoop(
  taskText: string,
  deps: LoopDeps,
  config: LoopConfig,
): Promise<LoopResult> {
  // Fail fast on a nonsensical config: a guard that can never be evaluated
  // sanely must not get the chance to loop forever or end a run spuriously.
  if (
    config.maxTurns !== Infinity &&
    (!Number.isInteger(config.maxTurns) || config.maxTurns < 1)
  ) {
    throw new Error(`maxTurns must be an integer >= 1 or Infinity, got ${config.maxTurns}`);
  }
  if (Number.isNaN(config.maxContextTokens) || config.maxContextTokens < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${config.maxContextTokens}`);
  }

  const budget = createRunBudgetTracker({
    maxWorkerTurns: config.maxTurns,
    maxToolCalls: Infinity,
    maxModelTokens: Infinity,
    maxToolResultBytes: Infinity,
    maxWallTimeMs: Infinity,
    maxVerifierCorrections: Infinity,
  });
  const session = createWorkerSession(taskText, deps, {
    budget,
    maxContextTokens: config.maxContextTokens,
  });

  try {
    const outcome = await runWorkerCycle(session);
    if (outcome.kind === 'completed') {
      writeWorkerSessionMetrics(session, 'completed');
      return { status: 'completed', finalText: outcome.finalText };
    }
    if (outcome.kind === 'submitted') {
      // Unreachable on this path: the submission protocol is off unless the
      // caller sets deps.submissionProtocol, which only the verification
      // harness does — and that harness does not go through this wrapper.
      throw new Error(
        'runAgentLoop received a submission; use runVerificationHarness for submission runs',
      );
    }
    writeWorkerSessionMetrics(session, 'budget_exceeded');
    return { status: 'budget_exceeded', reason: outcome.reason };
  } catch (error) {
    recordWorkerSessionCrash(session, error);
    throw error;
  }
}
