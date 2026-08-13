import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  isModelResponseRejectedError,
  isProtocolCorrectableRejection,
} from '../model/modelDriver.js';
import type { RunBudgetLimit, RunBudgetTracker, RunRoleUsage } from '../run/runBudget.js';
import { appendTranscriptEvent } from '../run/transcript.js';
import {
  MAX_TOOL_RESULTS_PER_MESSAGE_BYTES,
  offloadResult,
  PREVIEW_MAX_BYTES,
} from '../tools/capResult.js';
import type { ToolCall, ToolCallResult } from '../tools/pipeline.js';
import type { ToolCtx, ToolRegistry } from '../tools/registry.js';
import { elideStaleInspectResults } from './contextView.js';
import { scheduleToolCalls } from './scheduler.js';
import type {
  AssistantContentBlock,
  CallModel,
  Message,
  ModelResponse,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';

// One persistent worker conversation for the whole run. The old shape gave
// every harness cycle a fresh runAgentLoop — a fresh opening message, fresh
// guards, and total amnesia about the browsing already done. A
// WorkerSession owns the run's single mutable conversation: verifier
// corrections append feedback to the SAME state (appendWorkerFeedback), so
// the next turn's request replays everything the worker already learned,
// and every turn — first cycle or fifth correction — charges the same
// unresettable RunBudgetTracker.

/** Name of the metrics file written into the run directory. */
export const METRICS_FILENAME = 'metrics.json';

/**
 * How many rejected-response protocol corrections one run may spend. A
 * rejected attempt (too many tool calls, malformed call, output-limit
 * overflow — see modelDriver's protocol-correctable reasons) costs a turn
 * and appends only a short correction; the rejected content itself never
 * enters history. The cap keeps a model stuck in a rejection loop from
 * burning the whole budget on corrections.
 */
export const MAX_PROTOCOL_CORRECTIONS_PER_RUN = 3;

/**
 * Everything external the worker touches. The session performs no I/O
 * except through this bundle: the model only via `callModel`, tools only
 * via `registry` (through the standard pipeline), and files (transcript,
 * metrics, tool output) only inside `runDir`.
 */
export interface WorkerSessionDeps {
  /** Produces the model's response for the conversation so far. */
  callModel: CallModel;
  /** The tools available to this run. */
  registry: ToolRegistry;
  /** Absolute path to this run's directory; its manifest must already be
   * initialized. */
  runDir: string;
  /** Browser session for runs whose registry includes browser tools. */
  browser?: ToolCtx['browser'];
  /** Stored login credentials for fill_credentials. */
  credentials?: ToolCtx['credentials'];
  /** Resolver for interactive tool calls; omitted in headless runs. */
  requestPermission?: ToolCtx['requestPermission'];
}

/** The session's guards: the shared whole-run budget plus the per-request
 * context ceiling (see the old LoopConfig.maxContextTokens contract —
 * semantics unchanged). */
export interface WorkerSessionConfig {
  /** The run's single budget; shared with every other model role. */
  budget: RunBudgetTracker;
  /** Per-request context ceiling, >= 0 and never NaN. */
  maxContextTokens: number;
}

/**
 * The session's entire mutable memory: the conversation so far and how
 * many worker turns have happened. Mutated only by runWorkerTurn and
 * appendWorkerFeedback; nothing else writes to it.
 */
export interface WorkerSessionState {
  /** Full conversation: task, assistant responses, tool results, feedback. */
  messages: Message[];
  /** Worker model calls made so far, across all cycles and corrections. */
  turnCount: number;
}

/** Which guard ended a budget_exceeded outcome. `max_turns` and
 * `context_budget` keep their historical names; the rest are the shared
 * budget tracker's ceilings surfacing through the same channel. */
export type WorkerBudgetReason =
  | 'max_turns'
  | 'context_budget'
  | 'tool_calls'
  | 'model_tokens'
  | 'tool_result_bytes'
  | 'wall_time';

/** What one advanced turn concluded. `working`: tools ran, the
 * conversation grew, call again. The other two are terminal for the
 * current cycle (though a `completed` session can continue after
 * appendWorkerFeedback — that is the whole point). */
export type WorkerTurnOutcome =
  | { kind: 'working' }
  | { kind: 'completed'; finalText: string }
  | { kind: 'budget_exceeded'; reason: WorkerBudgetReason };

/** One live worker session. Treat every field as owned by this module;
 * callers hold the object only to pass it back in. */
export interface WorkerSession {
  readonly deps: WorkerSessionDeps;
  readonly config: WorkerSessionConfig;
  readonly state: WorkerSessionState;
  /** Largest per-request context seen (see RunMetrics.peakContextTokens). */
  peakContextTokens: number;
  /** Protocol corrections spent (see MAX_PROTOCOL_CORRECTIONS_PER_RUN). */
  protocolCorrections: number;
  /** Wall-clock start of the session, for metrics. */
  readonly startedMs: number;
}

/**
 * The run's summary numbers, written to <runDir>/metrics.json at run end.
 * Aggregate fields sum EVERY role recorded on the run's budget tracker
 * (worker-only runs are byte-compatible with the old worker-only sums);
 * `roles` breaks the same numbers down per role.
 *
 * Accounting caveat: token sums count only responses a model call
 * reported usage for. A transport-failed attempt that callWithRetry
 * retried billed real tokens upstream but reported no usage here.
 */
export interface RunMetrics {
  /** How the run ended. 'completed'/'budget_exceeded' come from judge-less
   * runs; 'verified'/'incomplete' from harness runs; 'failed' is written
   * only when the run crashed (never returned as a result). */
  status: 'completed' | 'budget_exceeded' | 'verified' | 'incomplete' | 'failed';
  /** Worker model calls made. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Largest per-request context of the run. */
  peakContextTokens: number;
  /** Wall-clock duration of the run in milliseconds. */
  wallClockMs: number;
  /** Per-role usage; present on every run written by WorkerSession. */
  roles?: Partial<Record<string, RunRoleUsage>>;
}

/**
 * Create one worker session.
 *
 * @param taskText - the user's task, sent as the conversation's first message
 * @param deps - the session's only I/O surface; deps.runDir must be an
 *   existing run directory with an initialized manifest
 * @param config - guards; throws before any model call if maxContextTokens
 *   is negative or NaN (the budget tracker validated its own limits at its
 *   construction)
 */
export function createWorkerSession(
  taskText: string,
  deps: WorkerSessionDeps,
  config: WorkerSessionConfig,
): WorkerSession {
  if (Number.isNaN(config.maxContextTokens) || config.maxContextTokens < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${config.maxContextTokens}`);
  }
  return {
    deps,
    config,
    state: {
      messages: [{ role: 'user', content: [{ type: 'text', text: taskText }] }],
      turnCount: 0,
    },
    peakContextTokens: 0,
    protocolCorrections: 0,
    startedMs: Date.now(),
  };
}

/**
 * Append verifier (or other harness) feedback to the same conversation. The
 * next runWorkerTurn's request replays the full prior exchange plus exactly
 * this feedback once — the worker keeps its browser knowledge instead of
 * starting over. Does not consume a turn and resets no budget.
 */
export function appendWorkerFeedback(session: WorkerSession, feedback: string): void {
  session.state.messages.push({ role: 'user', content: [{ type: 'text', text: feedback }] });
}

/** Map a tripped tracker ceiling onto the outcome's reason vocabulary. */
function budgetReasonForLimit(limit: RunBudgetLimit): WorkerBudgetReason {
  switch (limit) {
    case 'worker_turns':
      return 'max_turns';
    case 'tool_calls':
      return 'tool_calls';
    case 'model_tokens':
      return 'model_tokens';
    case 'tool_result_bytes':
      return 'tool_result_bytes';
    case 'wall_time':
      return 'wall_time';
    case 'verifier_corrections':
      // Corrections are charged by the harness between cycles, never
      // mid-turn; surfacing it here would misattribute the guard.
      return 'max_turns';
  }
}

/**
 * Advance the session by one turn: ask the model, execute any requested
 * tools, feed results back into the same conversation.
 *
 * Semantics are the long-standing loop contract, unchanged: completion is
 * decided by inspecting content for tool_use blocks (never stop_reason);
 * tools run through the scheduler (parallel capped reads, serialized
 * writes, request order preserved); one message's combined results are
 * bounded by the batch cap with offload as the remedy; the model sees the
 * elided API message view while state keeps every result; transcript
 * events (model_request/model_response/tool_call/tool_result/
 * cache_miss_warning/model_response_rejected) record everything, with
 * every guard checked after tool execution, max_turns first.
 *
 * What T1/T2 add: a strict-driver rejection never enters history (bounded
 * protocol corrections, context exhaustion → budget outcome, anything
 * else propagates), and every model call and attempted tool call charges
 * the session's shared RunBudgetTracker — which corrections never reset.
 */
export async function runWorkerTurn(session: WorkerSession): Promise<WorkerTurnOutcome> {
  const { deps, config, state } = session;
  const budget = config.budget;

  state.turnCount += 1;
  const turn = state.turnCount;

  const requestMessages = elideStaleInspectResults(state.messages);
  appendTranscriptEvent(deps.runDir, { type: 'model_request', turn, messages: requestMessages });
  const turnStartedMs = Date.now();
  let response: ModelResponse;
  try {
    response = await deps.callModel(requestMessages);
  } catch (error) {
    // A strict-driver rejection: the whole response was discarded before
    // history or execution (T1). Record it, charge its usage, and either
    // end truthfully or hand the same conversation a short protocol
    // correction — never the rejected content.
    if (!isModelResponseRejectedError(error)) throw error;
    appendTranscriptEvent(deps.runDir, {
      type: 'model_response_rejected',
      turn,
      reason: error.reason,
      message: error.message,
    });
    if (error.usage !== undefined) {
      budget.recordModelUsage('worker', error.usage, Date.now() - turnStartedMs);
    }
    if (error.reason === 'context_exhausted') {
      return { kind: 'budget_exceeded', reason: 'context_budget' };
    }
    if (
      isProtocolCorrectableRejection(error.reason) &&
      session.protocolCorrections < MAX_PROTOCOL_CORRECTIONS_PER_RUN
    ) {
      session.protocolCorrections += 1;
      state.messages.push({
        role: 'user',
        content: [{ type: 'text', text: error.protocolFeedback }],
      });
      // The rejected call still consumed a turn; honor the guards before
      // asking again.
      const limit = budget.exceededLimit();
      if (limit !== undefined) {
        return { kind: 'budget_exceeded', reason: budgetReasonForLimit(limit) };
      }
      return { kind: 'working' };
    }
    throw error;
  }
  appendTranscriptEvent(deps.runDir, { type: 'model_response', turn, response });
  budget.recordModelUsage('worker', response.usage, Date.now() - turnStartedMs);

  // This response's full context: the entire prompt the model just saw
  // (uncached input + cache writes + cache reads) plus what it wrote.
  const contextTokens =
    response.usage.input_tokens +
    (response.usage.cache_creation_input_tokens ?? 0) +
    (response.usage.cache_read_input_tokens ?? 0) +
    response.usage.output_tokens;
  session.peakContextTokens = Math.max(session.peakContextTokens, contextTokens);

  // Cache-miss tripwire: from turn 2 the stable prompt prefix alone
  // guarantees cache reads, so zero means the prefix silently broke —
  // make it visible in the run dir rather than only in the bill.
  if (turn >= 2 && (response.usage.cache_read_input_tokens ?? 0) === 0) {
    appendTranscriptEvent(deps.runDir, { type: 'cache_miss_warning', turn });
  }

  state.messages.push({ role: 'assistant', content: response.content });

  // Completion as policy: the model is done iff its response contains no
  // tool_use blocks. Checked on content, never on stop_reason.
  const toolUses = response.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  );
  if (toolUses.length === 0) {
    return { kind: 'completed', finalText: extractText(response.content) };
  }

  // Execution is delegated to the scheduler — read-only tools in parallel
  // (capped), state-changing tools serialized, results back in request
  // order. Transcript events bracket the batch deterministically.
  const calls: ToolCall[] = toolUses.map((block) => ({
    id: block.id,
    name: block.name,
    input: block.input,
  }));
  budget.recordToolCalls(calls.length);
  for (const call of calls) {
    appendTranscriptEvent(deps.runDir, { type: 'tool_call', turn, call });
  }
  const toolCtx: ToolCtx = {
    runDir: deps.runDir,
    browser: deps.browser,
    credentials: deps.credentials,
    requestPermission: deps.requestPermission,
  };
  // The batch cap runs before the transcript's tool_result events so the
  // transcript records exactly what the model will see next turn.
  const results = capResultBatch(
    deps.runDir,
    calls,
    await scheduleToolCalls(calls, deps.registry, toolCtx),
  );
  const resultBlocks: ToolResultBlock[] = results.map((result) => {
    appendTranscriptEvent(deps.runDir, { type: 'tool_result', turn, result });
    return toResultBlock(result);
  });
  budget.recordToolResultBytes(
    results.reduce(
      (sum, result) =>
        sum + (typeof result.content === 'string' ? Buffer.byteLength(result.content, 'utf8') : 0),
      0,
    ),
  );
  state.messages.push({ role: 'user', content: resultBlocks });

  // Guards, in the design's loop order: after tool execution, before the
  // next model call. The turn ceiling takes precedence when several trip.
  const limit = budget.exceededLimit();
  if (limit !== undefined) {
    return { kind: 'budget_exceeded', reason: budgetReasonForLimit(limit) };
  }
  if (contextTokens > config.maxContextTokens) {
    return { kind: 'budget_exceeded', reason: 'context_budget' };
  }
  return { kind: 'working' };
}

/** Advance the session until the current cycle ends: completed or budget
 * exceeded. After a `completed` outcome the session remains usable —
 * append feedback and call again for a correction cycle. */
export async function runWorkerCycle(
  session: WorkerSession,
): Promise<Exclude<WorkerTurnOutcome, { kind: 'working' }>> {
  for (;;) {
    const outcome = await runWorkerTurn(session);
    if (outcome.kind !== 'working') return outcome;
  }
}

/**
 * Write <runDir>/metrics.json for this session: aggregates summed over
 * every role on the shared budget tracker, plus the per-role breakdown.
 */
export function writeWorkerSessionMetrics(
  session: WorkerSession,
  status: RunMetrics['status'],
): void {
  const roles = session.config.budget.roleUsage();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const usage of Object.values(roles)) {
    if (usage === undefined) continue;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadInputTokens += usage.cacheReadInputTokens;
    totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  }
  const metrics: RunMetrics = {
    status,
    turns: session.state.turnCount,
    ...totals,
    peakContextTokens: session.peakContextTokens,
    wallClockMs: Date.now() - session.startedMs,
    roles,
  };
  writeFileSync(
    join(session.deps.runDir, METRICS_FILENAME),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Crash bookkeeping, not recovery: record a run_error transcript event and
 * failed metrics, then let the caller rethrow. An AbortError gets no
 * bookkeeping at all — cancellation is "stopped", not "crashed", and a
 * cancelled run's directory stays free of metrics.json by design.
 */
export function recordWorkerSessionCrash(session: WorkerSession, error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') return;
  appendTranscriptEvent(session.deps.runDir, {
    type: 'run_error',
    turn: session.state.turnCount,
    message: error instanceof Error ? error.message : String(error),
  });
  writeWorkerSessionMetrics(session, 'failed');
}

/** A response's prose: its text blocks joined with newlines ("" if none). */
function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Below this size a note-only offload replacement (~250 bytes of JSON)
 * cannot shrink a result, so offloading it would grow the message. Only
 * reachable with hundreds of tiny results in one batch. */
const OFFLOAD_REPLACEMENT_FLOOR_BYTES = 320;

/**
 * Bound one message's combined tool-result bytes (the per-message batch
 * cap). Each result already passed the pipeline's per-result cap, but a
 * batch of individually-legal results can still flood one user message —
 * 5 parallel reads × 50k bytes is ~250k. While the batch's combined
 * content exceeds MAX_TOOL_RESULTS_PER_MESSAGE_BYTES, the largest
 * not-yet-offloaded result is written to a scratch/tool-output/ file
 * (manifest hash preserved, same replacement shape as the per-result cap)
 * — the remedy is offload, the run keeps going. Results above preview size
 * keep a preview; once previews alone cannot shrink the message under the
 * cap, remaining results are offloaded with a compact path/note-only
 * replacement (no preview) so many individually small results still cannot
 * produce a deliberately over-limit message. The returned array always
 * matches `results` positionally, untouched entries by identity.
 */
function capResultBatch(
  runDir: string,
  calls: readonly ToolCall[],
  results: readonly ToolCallResult[],
): ToolCallResult[] {
  const bounded = [...results];
  const sizes = bounded.map((result) => Buffer.byteLength(result.content, 'utf8'));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const offloaded = new Set<number>();

  while (total > MAX_TOOL_RESULTS_PER_MESSAGE_BYTES) {
    let largest = -1;
    for (let index = 0; index < bounded.length; index += 1) {
      if (offloaded.has(index)) continue;
      if (largest === -1 || sizes[index]! > sizes[largest]!) largest = index;
    }
    // Stop only when no remaining result is large enough for a replacement
    // to shrink it — physically unreachable short of hundreds of tiny
    // results, and never a deliberate over-limit return.
    if (largest === -1 || sizes[largest]! <= OFFLOAD_REPLACEMENT_FLOOR_BYTES) break;

    // Offload file names come from the model-supplied tool name here (the
    // pipeline's capResult gets registry names); sanitize so an unknown-tool
    // result can never smuggle path separators into the offload dir.
    const safeToolName = calls[largest]!.name.replace(/[^A-Za-z0-9_-]/g, '_');
    // Once a result no longer exceeds preview size, a preview would repeat
    // most of the content — the replacement keeps only the path + note.
    const previewBytes = sizes[largest]! > PREVIEW_MAX_BYTES ? PREVIEW_MAX_BYTES : 0;
    const replacement = JSON.stringify(offloadResult(
      runDir,
      safeToolName,
      bounded[largest]!.content,
      `over the ${MAX_TOOL_RESULTS_PER_MESSAGE_BYTES}-byte combined limit ` +
        "for one message's tool results",
      previewBytes,
    ));
    bounded[largest] = { ...bounded[largest]!, content: replacement };
    total -= sizes[largest]!;
    sizes[largest] = Buffer.byteLength(replacement, 'utf8');
    total += sizes[largest]!;
    offloaded.add(largest);
  }

  return bounded;
}

/** Convert one pipeline result into the API-shaped tool_result block the
 * model reads next turn; is_error appears only on failures. */
function toResultBlock(result: ToolCallResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}
