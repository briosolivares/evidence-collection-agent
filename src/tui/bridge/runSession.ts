// The agent bridge for one live run: adapts runTask's injection seams into
// the TUI's single ordered UiEvent stream, with Esc-able cancellation —
// all with zero agent-core changes (R11).
//
// This module drives every run through runTask's OWN production model
// client: it forwards `onProgress` (mapped to UiEvent below), `signal`, and
// `createStream` into RunTaskConfig and lets runTask build and own the
// client rather than constructing a second model or tool registry. `runTask`
// threads `signal` and `createStream` through initializer, worker, and
// verifier roles, so cancellation reaches the in-flight role and the bridge
// always observes the exact production v3 tool surface.
//
// Progress mapping is a straight passthrough of `ProgressEvent` (see
// model/callModel.ts) onto this module's `UiEvent`s: turn_start →
// turn_start; text_delta → text_delta; tool_use_start → tool_pending;
// turn_end → turn_end with usage read off the response's `Usage`. `retry`
// is intentionally dropped (no corresponding UiEvent exists). Aborting
// rejects the in-flight model call; the error propagates out of the loop
// (no interior catch) through runTask's `finally` (tab closed, manifest
// finalized) and rejects the runTask promise — this module's outer `catch`
// then maps a rejection observed after `controller.abort()` to
// `run_cancelled` without depending on one AbortError normalization. The one
// exception is a browser-death/task-page-cleanup failure: even during
// cancellation it stays `run_failed` so the session runtime replaces the
// poisoned controller before another task. Deltas from an attempt the driver
// later rejects are ephemeral live output only — rejected attempts never
// reach the transcript or the conversation.

import type { BrowserController } from '../../browser/controller.js';
import type { BrowserJavaScriptPolicy } from '../../browser/browserJavaScript.js';
import {
  runTask,
  type HarnessConfig,
  type RunTaskConfig,
  type RunTaskResult,
} from '../../agent/runTask.js';
import type { ProgressEvent } from '../../model/callModel.js';
import type { ModelDriverConfig } from '../../model/modelDriver.js';
import type { RunTracing } from '../../tracing/runTracing.js';
import { createTuiTracing } from './tuiTracing.js';
import { isBrowserDeathMessage } from './browserDeath.js';
import type { PermissionDecision, PermissionRequest } from '../../tools/registry.js';
import type { UiEvent } from '../store/state.js';
import type { UnresolvedRequirement } from '../../run/runOutcome.js';

/** How a bridged run ended, for callers awaiting `done`. `verified` and
 * `incomplete` are the only outcomes `runTask` itself can produce (every
 * run now goes through the initializer → worker → verifier harness);
 * `incomplete` is an early stop with the run preserved, kept distinct from
 * `failed` (a runtime crash outside the harness's own accounting). */
export type RunOutcome =
  | { status: 'verified'; finalText: string; runDir: string }
  | {
      status: 'incomplete';
      reason: string;
      detail?: string;
      finalText: string;
      unresolved: readonly UnresolvedRequirement[];
      runDir: string;
    }
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
  maxTurns?: number;
  maxContextTokens?: number;
  /** Whether the browser carries logged-in authority. */
  authenticated?: boolean;
  /** Explicit capability decision for authenticated browser sessions. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  startUrl?: string;
  /** Tuning for the initializer → worker → verifier harness every run now
   * goes through; forwarded to `runTask` verbatim. Omitted — the
   * production default — gets every default (a live initializer call,
   * three worker cycles, a live verifier). Tests inject scripted initializer
   * and verifier calls so no model role can reach the network. */
  harness?: HarnessConfig;
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
  createStream?: ModelDriverConfig['createStream'];
  /** Test seam: clock for event stamps. */
  now?: () => number;
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

  // 1:1 with ProgressEvent (see model/callModel.ts), forwarded into
  // RunTaskConfig.onProgress so runTask's own model client — worker,
  // initializer, and verifier alike — reports through this bridge instead
  // of a second client built here: turn_start → turn_start; text_delta →
  // text_delta; tool_use_start → tool_pending; turn_end → turn_end with
  // usage read off the response's Usage. `retry` has no corresponding
  // UiEvent and is dropped.
  const onProgress = (event: ProgressEvent): void => {
    switch (event.type) {
      case 'turn_start':
        emit({ type: 'turn_start', turn: event.turn });
        break;
      case 'text_delta':
        emit({ type: 'text_delta', text: event.text });
        break;
      case 'tool_use_start':
        emit({ type: 'tool_pending', name: event.toolName });
        break;
      case 'turn_end':
        emit({
          type: 'turn_end',
          usage: {
            input: event.usage.input_tokens,
            output: event.usage.output_tokens,
            ...(event.usage.cache_read_input_tokens === null ||
            event.usage.cache_read_input_tokens === undefined
              ? {}
              : { cacheRead: event.usage.cache_read_input_tokens }),
          },
        });
        break;
      case 'retry':
        break;
    }
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
        onProgress,
        tracing,
        ...(deps.harness === undefined ? {} : { harness: deps.harness }),
        ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
        ...(deps.model === undefined ? {} : { model: deps.model }),
        ...(deps.maxTurns === undefined ? {} : { maxTurns: deps.maxTurns }),
        ...(deps.maxContextTokens === undefined
          ? {}
          : { maxContextTokens: deps.maxContextTokens }),
        ...(deps.authenticated === undefined
          ? {}
          : { authenticated: deps.authenticated }),
        ...(deps.javascriptPolicy === undefined
          ? {}
          : { javascriptPolicy: deps.javascriptPolicy }),
        ...(deps.startUrl === undefined ? {} : { startUrl: deps.startUrl }),
        ...(requestPermission === undefined ? {} : { requestPermission }),
        ...(deps.createStream === undefined ? {} : { createStream: deps.createStream }),
        // Reaches both an in-flight model request (runTask forwards this into
        // its own model client) and an in-flight tool (`ToolCtx.abortSignal`).
        // Cancelling used to take effect only at the next model call; a
        // `bash` command can hold a process group for two minutes, so without
        // the tool half a cancelled run would return while its command kept
        // running.
        signal,
      });
      switch (result.status) {
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
            detail: result.detail,
            finalText: result.finalText,
            unresolved: result.unresolved,
            runDir: result.runDir,
            at: now(),
          });
          return {
            status: 'incomplete',
            reason: result.reason,
            detail: result.detail,
            finalText: result.finalText,
            unresolved: result.unresolved,
            runDir: result.runDir,
          } as const;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted && !isBrowserDeathMessage(message)) {
        emit({ type: 'run_cancelled', at: now() });
        return { status: 'cancelled' } as const;
      }
      emit({ type: 'run_failed', message, at: now() });
      return { status: 'failed', message } as const;
    }
  })();

  return {
    cancel: () => controller.abort(),
    done,
  };
}
