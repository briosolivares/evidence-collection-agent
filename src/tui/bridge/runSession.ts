// The agent bridge for one live run: adapts runTask's injection seams into
// the TUI's single ordered UiEvent stream, with Esc-able cancellation —
// all with zero agent-core changes (R11).
//
// The load-bearing seam: passing `config.callModel` to runTask silently
// bypasses `config.onProgress` (the core only wires onProgress into its
// *default* client). This module's injected callModel therefore re-emits
// the progress events itself — turn_start, text_delta, tool_use_start (as
// tool_pending), turn_end — around the same strict ModelDriver runTask's
// default client uses (createAnthropicModelDriver): TUI and non-TUI
// callers differ only in callbacks and cancellation, never in request or
// acceptance semantics. Aborting rejects the in-flight model call; the
// error propagates out of the loop (no interior catch) through runTask's
// `finally` (tab closed, manifest finalized) and rejects the runTask
// promise. Deltas from an attempt the driver later rejects are ephemeral
// live output only — rejected attempts never reach the transcript or the
// conversation.

import type Anthropic from '@anthropic-ai/sdk';

import type { BrowserController } from '../../browser/controller.js';
import type { CallModel } from '../../loop/messages.js';
import { runTask, type RunTaskConfig, type RunTaskResult } from '../../cli/runTask.js';
import { SYSTEM_PROMPT } from '../../cli/systemPrompt.js';
import { DEFAULT_MODEL } from '../../model/callModel.js';
import { createAnthropicModelDriver } from '../../model/modelDriver.js';
import type { ModelStreamEvent } from '../../model/streamAssembly.js';
import type { RunTracing } from '../../tracing/runTracing.js';
import { createTuiTracing } from './tuiTracing.js';
import {
  createBashTool,
  createProductionRegistry,
  DEFAULT_TOOL_PROFILE,
  type ToolProfile,
} from '../../tools/index.js';
import {
  toApiToolDefs,
  type PermissionDecision,
  type PermissionRequest,
} from '../../tools/registry.js';
import type { UiEvent } from '../store/state.js';

// Mirrors the core's (module-private) per-call output-token default.
const MAX_OUTPUT_TOKENS = 8_192;

/** How a bridged run ended, for callers awaiting `done`. `verified` and
 * `incomplete` arrive only from harness-mode runs (the TUI's interactive
 * runs are judge-less today); incomplete is an early stop with the run
 * preserved, kept distinct from `failed` (a runtime crash). */
export type RunOutcome =
  | { status: 'completed'; finalText: string; runDir: string }
  | { status: 'budget_exceeded'; reason: string; runDir: string }
  | { status: 'verified'; finalText: string; runDir: string }
  | { status: 'incomplete'; reason: string; runDir: string }
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
  browser: BrowserController;
  /** Receives the run's ordered UiEvent stream. */
  onEvent: (event: UiEvent) => void;
  runsBaseDir?: string;
  model?: string;
  toolProfile?: ToolProfile;
  maxTurns?: number;
  maxContextTokens?: number;
  startUrl?: string;
  /** Tracing the TUI's adapter delegates to; defaults to the core's
   * createRunTracing() so Langfuse observability is preserved. */
  tracingDelegate?: RunTracing;
  /** Resolves interactive tool calls (the App's question dialog). Omitted —
   * evals, headless — interactive tools fail closed in the pipeline. */
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Test seam: replaces the core runTask. */
  runTaskFn?: (taskText: string, config: RunTaskConfig) => Promise<RunTaskResult>;
  /** Test seam: produces one model response's raw event stream. The
   * default creates an Anthropic SDK stream carrying the abort signal. */
  createStream?: (
    params: Anthropic.Messages.MessageStreamParams,
    signal: AbortSignal | undefined,
  ) => AsyncIterable<ModelStreamEvent>;
  /** Test seam: clock for event stamps. */
  now?: () => number;
}

/** The production tool surface, rebuilt exactly as runTask registers it —
 * needed here only to serialize the same stable API tool definitions.
 *
 * `bash` is run-scoped, so it must be constructed in order to be described.
 * The instance built here is never executed: the TUI supplies
 * `config.callModel`, so this side only produces the model-facing definition,
 * while the instance `runTask` builds — with the run's real secret-env
 * denylist — is the one that actually runs commands. The denylist does not
 * affect these bytes. It must still be present, though: an `apiToolDefs` list
 * missing `bash` would silently offer TUI runs a smaller surface than the
 * registry executing them, and a model cannot call a tool it was never given. */
function buildApiToolDefs(profile: ToolProfile) {
  return toApiToolDefs(
    createProductionRegistry(profile, {
      bash: createBashTool({ secretEnvDenylist: [] }),
    }),
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
  const toolProfile = deps.toolProfile ?? DEFAULT_TOOL_PROFILE;

  // The shared strict driver — the exact acceptance, retry, and request
  // semantics runTask's default client uses. Client construction stays
  // lazy inside the driver (a missing API key fails the first model call
  // and routes through the normal run_failed path, not submit).
  const driver = createAnthropicModelDriver({
    model: deps.model ?? DEFAULT_MODEL,
    system: SYSTEM_PROMPT,
    apiToolDefs: buildApiToolDefs(toolProfile),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(deps.createStream === undefined ? {} : { createStream: deps.createStream }),
  });

  let turn = 0;
  const callModel: CallModel = async (messages) => {
    if (signal.aborted) {
      throw Object.assign(new Error('run cancelled'), { name: 'AbortError' });
    }
    turn += 1;
    const thisTurn = turn;
    emit({ type: 'turn_start', turn: thisTurn });

    // The driver retries transport failures across stream creation AND
    // consumption and re-asks one max_tokens overflow; an abort rejects
    // immediately, including out of a backoff sleep. A retried attempt may
    // re-emit text_deltas the failed attempt already streamed — accepted
    // cosmetic wart (see ProgressEvent in callModel.ts); a rejected
    // attempt's deltas are never committed anywhere downstream.
    const accepted = await driver
      .generate({
        messages,
        signal,
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            emit({ type: 'text_delta', text: event.text });
          } else if (event.type === 'tool_use_start') {
            emit({ type: 'tool_pending', name: event.toolName });
          }
        },
      })
      .catch((error: unknown) => {
        // Any failure observed after abort IS the cancellation. Normalize
        // its name — the SDK's abort error keeps the default 'Error', and a
        // killed stream can surface as truncation — so the loop's abort
        // carve-out (cancelled runs get no failed-metrics bookkeeping)
        // fires regardless of shape.
        if (signal.aborted && !(error instanceof Error && error.name === 'AbortError')) {
          throw Object.assign(new Error('run cancelled'), { name: 'AbortError' });
        }
        throw error;
      });

    const response = accepted.response;
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

  // The pause/ask/answer channel: announce the question on the event
  // stream, then race the App's dialog against the run's abort signal —
  // cancelling during a pause resolves deny, the tool errors, and the loop
  // observes the abort at its next model call (run_cancelled as usual).
  // The dialog promise never rejects into the pipeline: a dialog failure
  // becomes a deny with the error as feedback.
  const askUser = deps.requestPermission;
  const requestPermission =
    askUser === undefined
      ? undefined
      : (request: PermissionRequest): Promise<PermissionDecision> => {
          emit({
            type: 'permission_request',
            toolName: request.toolName,
            input: request.input,
          });
          return new Promise<PermissionDecision>((resolve) => {
            const decide = (decision: PermissionDecision): void => {
              signal.removeEventListener('abort', onAbort);
              resolve(decision);
            };
            const onAbort = (): void =>
              decide({
                behavior: 'deny',
                feedback: 'The run was cancelled while waiting for the user.',
              });
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort);
            askUser(request).then(decide, (error: unknown) =>
              decide({
                behavior: 'deny',
                feedback:
                  `The question dialog failed: ${
                    error instanceof Error ? error.message : String(error)
                  }. Continue without this information.`,
              }),
            );
          });
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
        toolProfile,
        ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
        ...(deps.model === undefined ? {} : { model: deps.model }),
        ...(deps.maxTurns === undefined ? {} : { maxTurns: deps.maxTurns }),
        ...(deps.maxContextTokens === undefined
          ? {}
          : { maxContextTokens: deps.maxContextTokens }),
        ...(deps.startUrl === undefined ? {} : { startUrl: deps.startUrl }),
        ...(requestPermission === undefined ? {} : { requestPermission }),
        // The same signal the wrapped callModel above checks, handed to the
        // tools as well. Cancelling used to take effect only at the next model
        // call; a `bash` command can hold a process group for two minutes, so
        // without this a cancelled run would return while its command kept
        // running.
        signal,
      });
      switch (result.status) {
        case 'completed':
        case 'verified': {
          emit({
            type: 'run_finished',
            outcome: result.status,
            finalText: result.finalText,
            runDir: result.runDir,
            at: now(),
          });
          return {
            status: result.status,
            finalText: result.finalText,
            runDir: result.runDir,
          } as const;
        }
        case 'incomplete': {
          emit({
            type: 'run_finished',
            outcome: 'incomplete',
            reason: result.reason,
            runDir: result.runDir,
            at: now(),
          });
          return {
            status: 'incomplete',
            reason: result.reason,
            runDir: result.runDir,
          } as const;
        }
        case 'budget_exceeded': {
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
        }
      }
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
