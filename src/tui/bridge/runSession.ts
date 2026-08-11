// The agent bridge for one live run: adapts runTask's injection seams into
// the TUI's single ordered UiEvent stream, with Esc-able cancellation —
// all with zero agent-core changes (R11).
//
// The load-bearing seam: passing `config.callModel` to runTask silently
// bypasses `config.onProgress` (the core only wires onProgress into its
// *default* client). This module's injected callModel therefore re-emits
// all four progress events itself — turn_start, text_delta,
// tool_use_start (as tool_pending), turn_end — via the core's exported
// buildRequestParams + assembleModelResponse around an abortable SDK
// stream. Aborting rejects the in-flight model call; the error propagates
// out of the loop (no interior catch) through runTask's `finally` (tab
// closed, manifest finalized) and rejects the runTask promise.

import Anthropic from '@anthropic-ai/sdk';

import type { BrowserAdapter } from '../../browser/adapter.js';
import type { CallModel } from '../../loop/messages.js';
import { runTask, type RunTaskConfig, type RunTaskResult } from '../../cli/runTask.js';
import { SYSTEM_PROMPT } from '../../cli/systemPrompt.js';
import {
  buildRequestParams,
  DEFAULT_MODEL,
  type CallModelConfig,
} from '../../model/callModel.js';
import {
  assembleModelResponse,
  type ModelStreamEvent,
} from '../../model/streamAssembly.js';
import type { RunTracing } from '../../tracing/runTracing.js';
import { createTuiTracing } from './tuiTracing.js';
import { actionTools } from '../../tools/actionTools.js';
import { evidenceTools } from '../../tools/evidenceTools.js';
import { fileTools } from '../../tools/fileTools.js';
import { observationTools } from '../../tools/observationTools.js';
import { createRegistry, toApiToolDefs } from '../../tools/registry.js';
import type { UiEvent } from '../store/state.js';

// Mirrors the core's (module-private) per-call output-token default.
const MAX_OUTPUT_TOKENS = 8_192;

/** How a bridged run ended, for callers awaiting `done`. */
export type RunOutcome =
  | { status: 'completed'; finalText: string; runDir: string }
  | { status: 'budget_exceeded'; reason: string; runDir: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/** A live run: cancel it, or await its terminal outcome. */
export interface RunHandle {
  /** Abort the in-flight model call; an executing tool batch settles
   * first (bounded by browser timeouts). Idempotent. */
  cancel(): void;
  /** Resolves with the run's outcome; never rejects. */
  done: Promise<RunOutcome>;
}

/** Everything startRun needs; optional members are test/config seams. */
export interface RunSessionDeps {
  /** The session browser handed to the run (caller owns lifecycle). */
  browser: BrowserAdapter;
  /** Receives the run's ordered UiEvent stream. */
  onEvent: (event: UiEvent) => void;
  runsBaseDir?: string;
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  startUrl?: string;
  /** Tracing the TUI's adapter delegates to; defaults to the core's
   * createRunTracing() so Langfuse observability is preserved. */
  tracingDelegate?: RunTracing;
  /** Test seam: replaces the core runTask. */
  runTaskFn?: (taskText: string, config: RunTaskConfig) => Promise<RunTaskResult>;
  /** Test seam: produces one model response's raw event stream. The
   * default creates an Anthropic SDK stream carrying the abort signal. */
  createStream?: (
    params: Anthropic.Messages.MessageStreamParams,
    signal: AbortSignal,
  ) => AsyncIterable<ModelStreamEvent>;
  /** Test seam: clock for event stamps. */
  now?: () => number;
}

/** The production tool surface, rebuilt exactly as runTask registers it —
 * needed here only to serialize the same stable API tool definitions. */
function buildApiToolDefs() {
  return toApiToolDefs(
    createRegistry([
      ...fileTools,
      ...observationTools,
      ...actionTools,
      ...evidenceTools,
    ]),
  );
}

/**
 * Start one real agent run, streaming UiEvents to deps.onEvent.
 *
 * Event order per turn: turn_start → any text_delta / tool_pending events
 * in stream order → turn_end (with that turn's usage). run_started precedes the
 * first turn; exactly one terminal event (run_finished, run_cancelled, or
 * run_failed) ends the stream. After cancel(), any rejection out of
 * runTask maps to run_cancelled — the manifest is already finalized by
 * the core's `finally` on that path.
 */
export function startRun(task: string, deps: RunSessionDeps): RunHandle {
  const emit = deps.onEvent;
  const now = deps.now ?? Date.now;
  const runTaskFn = deps.runTaskFn ?? runTask;
  const controller = new AbortController();
  const { signal } = controller;

  // Lazy: constructing the SDK client can throw (missing API key); doing
  // it inside the first model call routes that failure through the normal
  // run_failed path instead of crashing submit.
  let client: Anthropic | undefined;
  const createStream =
    deps.createStream ??
    ((
      params: Anthropic.Messages.MessageStreamParams,
      streamSignal: AbortSignal,
    ) => {
      client ??= new Anthropic();
      return client.messages.stream(params, { signal: streamSignal });
    });

  const modelConfig: CallModelConfig = {
    model: deps.model ?? DEFAULT_MODEL,
    system: SYSTEM_PROMPT,
    apiToolDefs: buildApiToolDefs(),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  let turn = 0;
  const callModel: CallModel = async (messages) => {
    if (signal.aborted) {
      throw Object.assign(new Error('run cancelled'), { name: 'AbortError' });
    }
    turn += 1;
    const thisTurn = turn;
    emit({ type: 'turn_start', turn: thisTurn });

    const stream = createStream(buildRequestParams(modelConfig, messages), signal);
    const response = await assembleModelResponse(stream, (event) => {
      if (event.type === 'text_delta') {
        emit({ type: 'text_delta', text: event.text });
      } else {
        emit({ type: 'tool_pending', name: event.toolName });
      }
    });

    emit({
      type: 'turn_end',
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        ...(response.usage.cache_read_input_tokens === null ||
        response.usage.cache_read_input_tokens === undefined
          ? {}
          : { cacheRead: response.usage.cache_read_input_tokens }),
      },
    });
    return response;
  };

  emit({ type: 'run_started', task, at: now() });

  // The tracing seam gives the TUI tool inputs/results and the runDir
  // mid-run, while delegating spans to the real tracing (Langfuse).
  const tracing = createTuiTracing({
    onEvent: emit,
    ...(deps.tracingDelegate === undefined ? {} : { delegate: deps.tracingDelegate }),
  });

  const done: Promise<RunOutcome> = (async () => {
    try {
      const result = await runTaskFn(task, {
        browser: deps.browser,
        callModel,
        tracing,
        ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
        ...(deps.model === undefined ? {} : { model: deps.model }),
        ...(deps.maxTurns === undefined ? {} : { maxTurns: deps.maxTurns }),
        ...(deps.maxTokens === undefined ? {} : { maxTokens: deps.maxTokens }),
        ...(deps.startUrl === undefined ? {} : { startUrl: deps.startUrl }),
      });
      if (result.status === 'completed') {
        emit({
          type: 'run_finished',
          outcome: 'completed',
          finalText: result.finalText,
          runDir: result.runDir,
          at: now(),
        });
        return {
          status: 'completed',
          finalText: result.finalText,
          runDir: result.runDir,
        } as const;
      }
      emit({
        type: 'run_finished',
        outcome: 'budget_exceeded',
        reason: result.reason,
        runDir: result.runDir,
        at: now(),
      });
      return {
        status: 'budget_exceeded',
        reason: result.reason,
        runDir: result.runDir,
      } as const;
    } catch (error) {
      if (signal.aborted) {
        emit({ type: 'run_cancelled', at: now() });
        return { status: 'cancelled' } as const;
      }
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'run_failed', message, at: now() });
      return { status: 'failed', message } as const;
    }
  })();

  return {
    cancel: () => controller.abort(),
    done,
  };
}
