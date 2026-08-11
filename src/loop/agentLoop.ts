import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendTranscriptEvent } from '../run/transcript.js';
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
 * The run's hard guards. Both are required: together they guarantee the
 * loop terminates no matter what the model does.
 */
export interface LoopConfig {
  /** Maximum number of model calls (turns); an integer >= 1. Boundary: the
   * run may *complete* on the final allowed turn; if that turn's response
   * still requests tools, the tools are executed and recorded (guards run
   * after tool execution, per the design's loop diagram) and the run then
   * ends budget_exceeded instead of calling the model again. */
  maxTurns: number;
  /** Cumulative token budget across all responses, counting each
   * response's input_tokens + output_tokens + cache_read_input_tokens;
   * >= 0. Boundary: the budget is spendable in full — the run continues at
   * exactly maxTokens and ends budget_exceeded only when the total
   * strictly exceeds it. */
  maxTokens: number;
}

/** Which guard ended a budget_exceeded run. If both trip after the same
 * turn, max_turns is reported. */
export type BudgetReason = 'max_turns' | 'token_budget';

/**
 * How a run ended. `completed`: the model responded without tool calls;
 * `finalText` is that response's text (text blocks joined with newlines,
 * "" if it had none). `budget_exceeded`: a guard ended the run before the
 * model finished; `reason` names the guard.
 */
export type LoopResult =
  | { status: 'completed'; finalText: string }
  | { status: 'budget_exceeded'; reason: BudgetReason };

/** The run's summary numbers, written to <runDir>/metrics.json at run end. */
export interface RunMetrics {
  /** How the run ended. */
  status: LoopResult['status'];
  /** Model calls made. */
  turns: number;
  /** Sum of input_tokens across all responses. */
  inputTokens: number;
  /** Sum of output_tokens across all responses. */
  outputTokens: number;
  /** Sum of cache_read_input_tokens across all responses. */
  cacheReadInputTokens: number;
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
 * run even if its usage pushes the total past the token budget (the answer
 * is already in hand).
 *
 * Transcript: every model request, response, tool call, and tool result is
 * appended to <runDir>/transcript.jsonl as events `model_request` {turn,
 * messages}, `model_response` {turn, response}, `tool_call` {turn, call},
 * and `tool_result` {turn, result}. Within a turn, all tool_call events
 * are appended in request order before execution begins and all
 * tool_result events in request order after every call has settled
 * (parallel completion order is not observable in the transcript). On run
 * end — both statuses — <runDir>/metrics.json is written (see RunMetrics).
 *
 * @param taskText - the user's task, sent as the conversation's first message
 * @param deps - the loop's only I/O surface (see LoopDeps); deps.runDir
 *   must be an existing run directory with an initialized manifest
 * @param config - termination guards (see LoopConfig); throws before any
 *   model call if maxTurns is not an integer >= 1 or maxTokens is negative
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
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    throw new Error(`maxTurns must be an integer >= 1, got ${config.maxTurns}`);
  }
  if (config.maxTokens < 0) {
    throw new Error(`maxTokens must be >= 0, got ${config.maxTokens}`);
  }

  const startedMs = Date.now();
  const state: State = {
    messages: [{ role: 'user', content: [{ type: 'text', text: taskText }] }],
    turnCount: 0,
  };
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  const toolCtx: ToolCtx = { runDir: deps.runDir, browser: deps.browser };

  // Every exit path funnels through here, so no ending can skip metrics.
  const finish = (result: LoopResult): LoopResult => {
    const metrics: RunMetrics = {
      status: result.status,
      turns: state.turnCount,
      ...totals,
      wallClockMs: Date.now() - startedMs,
    };
    writeFileSync(
      join(deps.runDir, METRICS_FILENAME),
      `${JSON.stringify(metrics, null, 2)}\n`,
      'utf8',
    );
    return result;
  };

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
    const results = await scheduleToolCalls(calls, deps.registry, toolCtx);
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
    const cumulativeTokens =
      totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens;
    if (cumulativeTokens > config.maxTokens) {
      return finish({ status: 'budget_exceeded', reason: 'token_budget' });
    }
  }
}

/** A response's prose: its text blocks joined with newlines ("" if none). */
function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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
