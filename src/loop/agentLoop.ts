import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendTranscriptEvent } from '../run/transcript.js';
import {
  MAX_TOOL_RESULTS_PER_MESSAGE_BYTES,
  offloadResult,
  PREVIEW_MAX_BYTES,
} from '../tools/capResult.js';
import type { ToolCall, ToolCallResult } from '../tools/pipeline.js';
import type { ToolCtx, ToolRegistry } from '../tools/registry.js';
import { scheduleToolCalls } from './scheduler.js';
import type {
  AssistantContentBlock,
  CallModel,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';

/** Name of the metrics file the loop writes into the run directory. */
export const METRICS_FILENAME = 'metrics.json';

/**
 * The loop's entire memory of a run: the conversation so far and how many
 * turns (model calls) have happened. Created and mutated only by
 * `runAgentLoop`; nothing else writes to it.
 */
export interface State {
  /** Full conversation: the task, assistant responses, tool results. */
  messages: Message[];
  /** Number of model calls made so far. */
  turnCount: number;
}

/**
 * Everything external the loop touches. The loop performs no I/O except
 * through this bundle: the model only via `callModel`, tools only via
 * `registry` (through the standard pipeline), and files (transcript,
 * metrics, tool output) only inside `runDir`. This seam is what makes the
 * loop testable with a scripted fake model (T7), lets the real client (T9)
 * drop in unchanged, and gives tracing (T16) one place to wrap.
 */
export interface LoopDeps {
  /** Produces the model's response for the conversation so far. */
  callModel: CallModel;
  /** The tools available to this run. */
  registry: ToolRegistry;
  /** Absolute path to this run's directory; its manifest must already be
   * initialized (file-producing tools and result offloading record
   * provenance there). */
  runDir: string;
  /** Browser session for runs whose registry includes browser tools;
   * file-only runs omit it. Passed through to tool executors untouched. */
  browser?: ToolCtx['browser'];
}

/**
 * The run's hard guards. Both are required. A finite maxTurns bounds the
 * turn count outright; maxContextTokens bounds how large any single
 * request may grow — and because the conversation (and with it each
 * request's context) grows every turn, the context ceiling still
 * guarantees termination when maxTurns is Infinity.
 */
export interface LoopConfig {
  /** Maximum number of model calls (turns); an integer >= 1, or Infinity
   * to let a run follow its trajectory uncapped (the context ceiling below
   * still ends it eventually). Boundary: with a finite cap the run may
   * *complete* on the final allowed turn; if that turn's response
   * still requests tools, the tools are executed and recorded (guards run
   * after tool execution, per the design's loop diagram) and the run then
   * ends budget_exceeded instead of calling the model again. */
  maxTurns: number;
  /** Per-request context ceiling: the largest single request/response the
   * run may make, measured from each response's usage as input_tokens +
   * cache_creation_input_tokens + cache_read_input_tokens + output_tokens
   * (the full prompt the model just saw plus what it wrote — Claude Code's
   * canonical context measure; a cumulative sum would double-count history
   * every turn). >= 0. Boundary: spendable in full — the run continues at
   * exactly maxContextTokens and ends budget_exceeded only when one
   * response's context strictly exceeds it. Known simplification: the
   * guard measures the request the model just answered, not the one about
   * to be sent, so the next request can exceed the last measured context
   * by at most the just-appended tool results — bounded by the per-message
   * batch cap (MAX_TOOL_RESULTS_PER_MESSAGE_BYTES), so no token estimation
   * is needed. */
  maxContextTokens: number;
}

/** Which guard ended a budget_exceeded run. If both trip after the same
 * turn, max_turns is reported. */
export type BudgetReason = 'max_turns' | 'context_budget';

/**
 * How a run ended. `completed`: the model responded without tool calls;
 * `finalText` is that response's text (text blocks joined with newlines,
 * "" if it had none). `budget_exceeded`: a guard ended the run before the
 * model finished; `reason` names the guard.
 */
export type LoopResult =
  | { status: 'completed'; finalText: string }
  | { status: 'budget_exceeded'; reason: BudgetReason };

/**
 * The run's summary numbers, written to <runDir>/metrics.json at run end.
 *
 * Accounting caveat: token sums count only successful model calls. A
 * failed attempt that callWithRetry retried billed real tokens upstream
 * but reported no usage here, so retried turns undercount true cost
 * slightly.
 */
export interface RunMetrics {
  /** How the run ended. Beyond LoopResult's statuses, metrics alone can
   * say 'failed': the loop crashed, wrote what it knew, and rethrew — a
   * crash is never returned as a result, so 'failed' exists only in
   * metrics.json. */
  status: LoopResult['status'] | 'failed';
  /** Model calls made. */
  turns: number;
  /** Sum of input_tokens across all responses. */
  inputTokens: number;
  /** Sum of output_tokens across all responses. */
  outputTokens: number;
  /** Sum of cache_read_input_tokens across all responses. */
  cacheReadInputTokens: number;
  /** Sum of cache_creation_input_tokens across all responses. */
  cacheCreationInputTokens: number;
  /** Largest per-request context of the run: max over responses of
   * input + cache_creation + cache_read + output tokens. The depth number
   * for comparing runs across guard-semantics changes. */
  peakContextTokens: number;
  /** Wall-clock duration of the run in milliseconds. */
  wallClockMs: number;
}

/**
 * Run the agent loop to completion: ask the model, execute any tools it
 * requests, feed the results back, repeat — until the model responds
 * without tool calls or a guard trips.
 *
 * Whether the run continues is decided by inspecting each response's
 * *content* for tool_use blocks; its stop_reason label is deliberately
 * never consulted (content is ground truth — see ModelResponse). Requested
 * tools execute through the standard pipeline under the scheduling
 * contract of `scheduleToolCalls`: read-only tools in parallel (capped),
 * state-changing tools one at a time, request order preserved at batch
 * granularity. Their results return to the model as tool_result blocks
 * (failures flagged is_error), in request order, in one new user message.
 * Guards are checked after tool execution, before the next model call —
 * boundary semantics on LoopConfig; completion is checked before the
 * guards, so a final response that arrives within maxTurns completes the
 * run even if its usage exceeds the context budget (the answer is already
 * in hand).
 *
 * One message's combined tool results are bounded by
 * MAX_TOOL_RESULTS_PER_MESSAGE_BYTES on top of the pipeline's per-result
 * cap: when a batch exceeds it, the largest results are offloaded to
 * tool-output/ files (largest first, previews and manifest hashes
 * preserved) until the batch fits — the run keeps going; nothing dies.
 *
 * Transcript: every model request, response, tool call, and tool result is
 * appended to <runDir>/transcript.jsonl as events `model_request` {turn,
 * messages}, `model_response` {turn, response}, `tool_call` {turn, call},
 * and `tool_result` {turn, result}. Within a turn, all tool_call events
 * are appended in request order before execution begins and all
 * tool_result events in request order after every call has settled
 * (parallel completion order is not observable in the transcript); a
 * tool_result is recorded as the model will see it, after both caps. A
 * `cache_miss_warning` {turn} event is appended for any turn >= 2 whose
 * response reports zero cache reads — from turn 2 the stable prefix alone
 * guarantees a cache hit, so zero means the prefix silently broke (the
 * two-line version of Claude Code's prompt-cache break detection). On run
 * end — every ending — <runDir>/metrics.json is written (see RunMetrics):
 * completed, budget_exceeded, and, when the loop throws, status 'failed' —
 * in which case a final `run_error` {turn, message} event is appended to
 * the transcript and the error is rethrown unchanged (crash bookkeeping
 * only; callers see exactly the rejection they always saw). Exception: an
 * error named 'AbortError' is rethrown with no bookkeeping at all —
 * cancellation is "stopped", not "crashed", and a cancelled run's
 * directory stays free of metrics.json by design.
 *
 * @param taskText - the user's task, sent as the conversation's first message
 * @param deps - the loop's only I/O surface (see LoopDeps); deps.runDir
 *   must be an existing run directory with an initialized manifest
 * @param config - termination guards (see LoopConfig); throws before any
 *   model call if maxTurns is neither an integer >= 1 nor Infinity, or
 *   maxContextTokens is negative
 * @returns the run's outcome (see LoopResult); by return time the
 *   transcript holds the run's full event sequence and metrics.json its
 *   totals
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
  if (config.maxContextTokens < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${config.maxContextTokens}`);
  }

  const startedMs = Date.now();
  const state: State = {
    messages: [{ role: 'user', content: [{ type: 'text', text: taskText }] }],
    turnCount: 0,
  };
  // Cumulative sums are observability only (metrics, cost derivation) —
  // the guard below is per-request, never cumulative.
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let peakContextTokens = 0;
  const toolCtx: ToolCtx = { runDir: deps.runDir, browser: deps.browser };

  // Every ending funnels through here — returns via finish, crashes via
  // the catch below — so no exit can skip metrics.
  const writeMetrics = (status: RunMetrics['status']): void => {
    const metrics: RunMetrics = {
      status,
      turns: state.turnCount,
      ...totals,
      peakContextTokens,
      wallClockMs: Date.now() - startedMs,
    };
    writeFileSync(
      join(deps.runDir, METRICS_FILENAME),
      `${JSON.stringify(metrics, null, 2)}\n`,
      'utf8',
    );
  };
  const finish = (result: LoopResult): LoopResult => {
    writeMetrics(result.status);
    return result;
  };

  try {
    while (true) {
      state.turnCount += 1;
      const turn = state.turnCount;

      // appendTranscriptEvent serializes synchronously, so logging the live
      // messages array records a faithful snapshot of this turn's request
      // even though the loop mutates the array afterwards.
      appendTranscriptEvent(deps.runDir, { type: 'model_request', turn, messages: state.messages });
      const response = await deps.callModel(state.messages);
      appendTranscriptEvent(deps.runDir, { type: 'model_response', turn, response });

      totals.inputTokens += response.usage.input_tokens;
      totals.outputTokens += response.usage.output_tokens;
      totals.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
      totals.cacheCreationInputTokens += response.usage.cache_creation_input_tokens ?? 0;

      // This response's full context: the entire prompt the model just saw
      // (uncached input + cache writes + cache reads) plus what it wrote.
      const contextTokens =
        response.usage.input_tokens
        + (response.usage.cache_creation_input_tokens ?? 0)
        + (response.usage.cache_read_input_tokens ?? 0)
        + response.usage.output_tokens;
      peakContextTokens = Math.max(peakContextTokens, contextTokens);

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
        return finish({ status: 'completed', finalText: extractText(response.content) });
      }

      // T8: execution is delegated to the scheduler — read-only tools in
      // parallel (capped), state-changing tools serialized, results back in
      // request order. Transcript events bracket the batch deterministically:
      // every tool_call is logged before execution starts, every tool_result
      // after all calls settle, both in request order — so the transcript
      // stays replayable even though completion order varies run to run.
      const calls: ToolCall[] = toolUses.map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));
      for (const call of calls) {
        appendTranscriptEvent(deps.runDir, { type: 'tool_call', turn, call });
      }
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
      state.messages.push({ role: 'user', content: resultBlocks });

      // Guards, in the design's loop order: after tool execution, before the
      // next model call. maxTurns takes precedence when both trip at once.
      if (turn >= config.maxTurns) {
        return finish({ status: 'budget_exceeded', reason: 'max_turns' });
      }
      if (contextTokens > config.maxContextTokens) {
        return finish({ status: 'budget_exceeded', reason: 'context_budget' });
      }
    }
  } catch (error) {
    // Cancellation is "stopped", not "crashed": the design's cancellation
    // artifact contract (tests/tui/cancellation-artifacts.test.ts) keeps a
    // cancelled run's directory free of metrics.json so the /runs browser
    // can tell the two apart. The TUI bridge normalizes every post-abort
    // failure to this name.
    if (error instanceof Error && error.name === 'AbortError') throw error;

    // Crash bookkeeping, not a retry loop and not recovery: record what
    // happened where the run's artifacts live, then rethrow unchanged so
    // every caller sees exactly the rejection it sees today. The turns
    // already completed keep their metrics instead of vanishing.
    appendTranscriptEvent(deps.runDir, {
      type: 'run_error',
      turn: state.turnCount,
      message: error instanceof Error ? error.message : String(error),
    });
    writeMetrics('failed');
    throw error;
  }
}

/** A response's prose: its text blocks joined with newlines ("" if none). */
function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Bound one message's combined tool-result bytes (the per-message batch
 * cap). Each result already passed the pipeline's per-result cap, but a
 * batch of individually-legal results can still flood one user message —
 * 5 parallel reads × 50k bytes is ~250k. While the batch's combined
 * content exceeds MAX_TOOL_RESULTS_PER_MESSAGE_BYTES, the largest
 * not-yet-offloaded result is written to a tool-output/ file (manifest
 * hash and preview preserved, same replacement shape as the per-result
 * cap) — the remedy is offload, the run keeps going. Results at or under
 * preview size are never offloaded (replacing them couldn't shrink the
 * batch), so a pathological batch of many tiny results passes through
 * over-cap rather than looping; the returned array always matches
 * `results` positionally, untouched entries by identity.
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
    if (largest === -1 || sizes[largest]! <= PREVIEW_MAX_BYTES) break;

    // Offload file names come from the model-supplied tool name here (the
    // pipeline's capResult gets registry names); sanitize so an unknown-tool
    // result can never smuggle path separators into the offload dir.
    const safeToolName = calls[largest]!.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const replacement = JSON.stringify(offloadResult(
      runDir,
      safeToolName,
      bounded[largest]!.content,
      `over the ${MAX_TOOL_RESULTS_PER_MESSAGE_BYTES}-byte combined limit ` +
        "for one message's tool results",
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
