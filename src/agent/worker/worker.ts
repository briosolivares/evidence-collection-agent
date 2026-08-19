import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  ModelResponse,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../../model/messages.js';
import {
  isModelResponseRejectedError,
  isProtocolCorrectableRejection,
  knownModelUsageFromError,
  type ModelAttemptEvent,
  type ModelDriver,
  type ModelRejectionReason,
} from '../../model/modelDriver.js';
import {
  captureRunBudgetSnapshot,
  type RunBudgetLimit,
  type RunBudgetTracker,
  type RunRoleUsage,
} from '../../run/runBudget.js';
import { appendTranscriptEvent } from '../../run/transcript.js';
import {
  DEFAULT_MAX_RESULT_BYTES,
  MAX_TOOL_RESULTS_PER_MESSAGE_BYTES,
  offloadResult,
  PREVIEW_MAX_BYTES,
  capResult,
} from '../../tools/capResult.js';
import {
  executeToolCall,
  type ToolCall,
  type ToolCallResult,
} from '../../tools/pipeline.js';
import {
  createBusyResourceRegistry,
  type BusyResourceRegistry,
  type ToolCtx,
  type ToolRegistry,
} from '../../tools/registry.js';
import {
  FINISH_TOOL_NAME,
  finishInputSchema,
  type FinishInput,
} from '../../tools/finish/finish.js';
import { raceWithRunSignal } from '../runDeadline.js';
import { buildContextView } from './contextView.js';

export const METRICS_FILENAME = 'metrics.json';
export const MAX_PROTOCOL_CORRECTIONS = 3;

export const NO_TOOL_CONTINUATION =
  'Continue working with tools, or call finish alone when the requested work is ready.';

export interface WorkerDeps {
  /** Strict, fully assembled streaming driver. Partial responses never enter history. */
  model: ModelDriver;
  registry: ToolRegistry;
  runDir: string;
  browser?: ToolCtx['browser'];
  requestPermission?: ToolCtx['requestPermission'];
  /** Shared across every turn; a session creates one when the caller omits it. */
  busyRegistry?: BusyResourceRegistry;
  signal?: AbortSignal;
  onModelEvent?: (event: ModelAttemptEvent) => void;
  lifecycle?: WorkerHooks;
  /** Test/metrics seam. Budget wall time remains owned by RunBudgetTracker. */
  now?: () => number;
}

export interface WorkerConfig {
  /** One unresettable tracker shared with initializer/verifier roles. */
  budget: RunBudgetTracker;
  /** Maximum tokens in one accepted request/response context, or Infinity. */
  maxContextTokens: number;
}

export interface WorkerOpeningOptions {
  /** Per-run contract/resume facts; each remains a separate opening text block. */
  guidance?: readonly string[];
}

export interface WorkerState {
  /** Full, never-collapsed conversation. */
  messages: Message[];
  /** Logical worker model calls, including rejected responses. */
  turnCount: number;
}

export interface Worker {
  readonly deps: WorkerDeps;
  readonly config: WorkerConfig;
  readonly state: WorkerState;
  readonly startedMs: number;
  readonly busyRegistry: BusyResourceRegistry;
  peakContextTokens: number;
  protocolCorrections: number;
}

export interface WorkerSnapshot {
  messages: Message[];
  turnCount: number;
  peakContextTokens: number;
  protocolCorrections: number;
  startedMs: number;
}

export interface PendingToolTurn {
  turn: number;
  assistant: AssistantMessage;
  calls: ToolCall[];
  completedResults: ToolResultBlock[];
  nextCallIndex: number;
  effect: 'not_started' | 'uncertain';
}

export interface BeforeModelRequestEvent {
  turn: number;
  session: WorkerSnapshot;
  /** Pure collapsed request view; never aliases changed blocks into state. */
  messages: readonly Message[];
}

export interface FinishRequest {
  turn: number;
  call: ToolCall;
  input: FinishInput;
  assistantText: string;
}

export interface ModelAccountingEvent {
  turn: number;
  /** Aggregate known billable usage for this logical model call. */
  usage: Usage;
  outcome: 'accepted' | 'failed';
  session: WorkerSnapshot;
}

/**
 * Durable-state boundaries. Hooks receive defensive snapshots and cannot
 * mutate the live session. `afterDispatch` is conservatively awaited at the
 * dispatch boundary before the executor is invoked: once it succeeds, a
 * checkpoint may truthfully call the effect uncertain. A failure from either
 * pre-effect hook prevents execution and becomes that call's own error.
 * `afterModelAccounting` is awaited immediately after known model usage is
 * charged and before cancellation or accepted content can advance the turn.
 * `afterResult` and finish-hook failures are post-effect persistence failures
 * and propagate terminally; they are never disguised as retryable tool errors.
 */
export interface WorkerHooks {
  beforeModelRequest?(event: BeforeModelRequestEvent): Promise<void>;
  afterModelAccounting?(event: ModelAccountingEvent): Promise<void>;
  beforeCall?(pending: PendingToolTurn): Promise<void>;
  afterDispatch?(pending: PendingToolTurn): Promise<void>;
  afterResult?(pending: PendingToolTurn): Promise<void>;
  finishRequested?(event: {
    session: WorkerSnapshot;
    request: FinishRequest;
  }): Promise<void>;
  finishResultAppended?(event: {
    session: WorkerSnapshot;
    request: FinishRequest;
    result: ToolResultBlock;
  }): Promise<void>;
}

export type WorkerGuardReason =
  | 'max_turns'
  | 'context_budget'
  | 'tool_calls'
  | 'model_tokens'
  | 'wall_time'
  | 'verifier_corrections';

export type WorkerIncompleteReason =
  | WorkerGuardReason
  | 'model_rejected'
  | 'model_rejection_limit';

export type WorkerTurnOutcome =
  | { kind: 'working' }
  | { kind: 'finish_requested'; request: FinishRequest }
  | {
      kind: 'incomplete';
      reason: WorkerIncompleteReason;
      modelRejection?: ModelRejectionReason;
      detail?: string;
    };

export type WorkerOutcome = Exclude<
  WorkerTurnOutcome,
  { kind: 'working' }
>;

export type WorkerMetricsStatus =
  | 'verified'
  | 'incomplete'
  | 'failed'
  | 'cancelled';

export interface WorkerMetrics {
  status: WorkerMetricsStatus;
  turns: number;
  protocolCorrections: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolCalls: number;
  toolResultBytes: number;
  peakContextTokens: number;
  wallClockMs: number;
  roles: Partial<Record<string, RunRoleUsage>>;
}

export function createWorker(
  taskText: string,
  deps: WorkerDeps,
  config: WorkerConfig,
  options: WorkerOpeningOptions = {},
): Worker {
  assertContextCeiling(config.maxContextTokens);
  const now = deps.now ?? Date.now;
  return {
    deps,
    config,
    state: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: taskText },
            ...(options.guidance ?? []).map((text) => ({
              type: 'text' as const,
              text,
            })),
          ],
        },
      ],
      turnCount: 0,
    },
    startedMs: now(),
    busyRegistry: deps.busyRegistry ?? createBusyResourceRegistry(),
    peakContextTokens: 0,
    protocolCorrections: 0,
  };
}

export function captureWorkerSnapshot(
  session: Worker,
): WorkerSnapshot {
  return {
    messages: structuredClone(session.state.messages),
    turnCount: session.state.turnCount,
    peakContextTokens: session.peakContextTokens,
    protocolCorrections: session.protocolCorrections,
    startedMs: session.startedMs,
  };
}

export function restoreWorker(
  snapshot: WorkerSnapshot,
  deps: WorkerDeps,
  config: WorkerConfig,
): Worker {
  assertContextCeiling(config.maxContextTokens);
  assertSnapshot(snapshot);
  return {
    deps,
    config,
    state: {
      messages: structuredClone(snapshot.messages),
      turnCount: snapshot.turnCount,
    },
    startedMs: snapshot.startedMs,
    busyRegistry: deps.busyRegistry ?? createBusyResourceRegistry(),
    peakContextTokens: snapshot.peakContextTokens,
    protocolCorrections: snapshot.protocolCorrections,
  };
}

export function appendWorkerFeedback(
  session: Worker,
  feedback: string,
): void {
  session.state.messages.push({
    role: 'user',
    content: [{ type: 'text', text: feedback }],
  });
}

/** Remove only a trailing assistant turn whose tool uses have no answer. */
export function dropUnansweredAssistantTurn(session: Worker): boolean {
  const last = session.state.messages.at(-1);
  if (
    last?.role !== 'assistant' ||
    !last.content.some((block) => block.type === 'tool_use')
  ) {
    return false;
  }
  session.state.messages.pop();
  return true;
}

/** Advance one strict model turn and, for ordinary calls, one serial batch. */
export async function runWorkerTurn(
  session: Worker,
): Promise<WorkerTurnOutcome> {
  throwIfAborted(session.deps.signal);
  const existingGuard = guardReason(session);
  if (existingGuard !== undefined) {
    return { kind: 'incomplete', reason: existingGuard };
  }

  const turn = session.state.turnCount + 1;
  const requestMessages = buildContextView(session.state.messages);
  await session.deps.lifecycle?.beforeModelRequest?.({
    turn,
    session: captureWorkerSnapshot(session),
    messages: structuredClone(requestMessages),
  });
  throwIfAborted(session.deps.signal);
  session.state.turnCount = turn;

  appendTranscriptEvent(session.deps.runDir, {
    type: 'model_request',
    turn,
    messages: requestMessages,
  });

  const startedMs = now(session);
  let accepted;
  try {
    accepted = await raceWithRunSignal(
      () =>
        session.deps.model.generate({
          messages: requestMessages,
          ...(session.deps.signal === undefined
            ? {}
            : { signal: session.deps.signal }),
          ...(session.deps.onModelEvent === undefined
            ? {}
            : { onEvent: session.deps.onModelEvent }),
        }),
      session.deps.signal,
    );
  } catch (error) {
    const knownUsage = knownModelUsageFromError(error);
    if (knownUsage !== undefined) {
      await recordWorkerModelAccounting(
        session,
        turn,
        knownUsage,
        now(session) - startedMs,
        'failed',
      );
    }
    throwIfAborted(session.deps.signal);
    if (!isModelResponseRejectedError(error)) throw error;

    appendTranscriptEvent(session.deps.runDir, {
      type: 'model_response_rejected',
      turn,
      reason: error.reason,
      message: error.message,
    });
    if (error.reason === 'context_exhausted') {
      return {
        kind: 'incomplete',
        reason: 'context_budget',
        modelRejection: error.reason,
        detail: error.message,
      };
    }
    if (isProtocolCorrectableRejection(error.reason)) {
      if (session.protocolCorrections >= MAX_PROTOCOL_CORRECTIONS) {
        return {
          kind: 'incomplete',
          reason: 'model_rejection_limit',
          modelRejection: error.reason,
          detail: error.message,
        };
      }
      session.protocolCorrections += 1;
      appendWorkerFeedback(session, error.protocolFeedback);
      const correctionGuard = guardReason(session);
      return correctionGuard === undefined
        ? { kind: 'working' }
        : { kind: 'incomplete', reason: correctionGuard };
    }
    return {
      kind: 'incomplete',
      reason: 'model_rejected',
      modelRejection: error.reason,
      detail: error.message,
    };
  }

  const response = accepted.response;
  await recordWorkerModelAccounting(
    session,
    turn,
    accepted.usage,
    now(session) - startedMs,
    'accepted',
  );
  throwIfAborted(session.deps.signal);
  recordAcceptedResponse(session, turn, response);

  const contextTokens = requestContextTokens(response.usage);
  session.peakContextTokens = Math.max(
    session.peakContextTokens,
    contextTokens,
  );
  if (turn >= 2 && (response.usage.cache_read_input_tokens ?? 0) === 0) {
    appendTranscriptEvent(session.deps.runDir, {
      type: 'cache_miss_warning',
      turn,
    });
  }

  const assistant: AssistantMessage = {
    role: 'assistant',
    content: structuredClone(response.content),
  };
  session.state.messages.push(assistant);

  const calls = response.content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use')
    .map(toToolCall);
  const assistantText = extractText(response.content);

  if (calls.length === 0) {
    appendWorkerFeedback(session, NO_TOOL_CONTINUATION);
    appendTranscriptEvent(session.deps.runDir, {
      type: 'worker_continuation',
      turn,
      reason: 'no_tool_calls',
    });
    return afterTurnGuard(session, contextTokens);
  }

  session.config.budget.recordToolCalls(calls.length);
  calls.forEach((call) => {
    appendTranscriptEvent(session.deps.runDir, {
      type: 'tool_call',
      turn,
      call,
    });
  });
  const finishCalls = calls.filter((call) => call.name === FINISH_TOOL_NAME);
  if (finishCalls.length > 0 && calls.length !== 1) {
    const results = capCombinedResults(
      session.deps.runDir,
      calls,
      calls.map((call) =>
        generatedErrorResult(
          session.deps.runDir,
          call,
          call.name === FINISH_TOOL_NAME
            ? `Protocol error: ${FINISH_TOOL_NAME} must be the only tool call ` +
                'in its response; nothing in this response executed.'
            : 'Protocol error: this call was not executed because ' +
                `${FINISH_TOOL_NAME} was mixed with other tool calls. ` +
                `Call ${FINISH_TOOL_NAME} alone.`,
        ),
      ),
    );
    appendToolResults(session, turn, calls, results);
    return afterTurnGuard(session, contextTokens);
  }

  if (calls[0]!.name === FINISH_TOOL_NAME) {
    const call = calls[0]!;
    const parsed = finishInputSchema.safeParse(call.input);
    if (!parsed.success) {
      const result = generatedErrorResult(
        session.deps.runDir,
        call,
        formatInvalidInput(FINISH_TOOL_NAME, parsed.error.issues),
        'invalid_input',
      );
      appendToolResults(session, turn, calls, [result]);
      return afterTurnGuard(session, contextTokens);
    }

    const request: FinishRequest = {
      turn,
      call: structuredClone(call),
      input: parsed.data,
      assistantText,
    };
    // Completion is allowed on the final configured worker turn. Every
    // other hard ceiling (including model tokens, wall time, and context)
    // still applies before verification begins.
    const finishGuard = guardReason(session, contextTokens, ['worker_turns']);
    if (finishGuard !== undefined) {
      appendToolResults(session, turn, calls, [
        generatedErrorResult(
          session.deps.runDir,
          call,
          JSON.stringify({
            status: 'rejected',
            source: 'run_guard',
            reason: finishGuard,
            message:
              'Finish was not submitted because this accepted response crossed a hard run guard.',
          }),
        ),
      ]);
      return { kind: 'incomplete', reason: finishGuard };
    }

    appendTranscriptEvent(session.deps.runDir, {
      type: 'finish_requested',
      turn,
      input: request.input,
    });
    await session.deps.lifecycle?.finishRequested?.({
      session: captureWorkerSnapshot(session),
      request: structuredClone(request),
    });
    return { kind: 'finish_requested', request };
  }

  const results = await executeSequentialCalls(
    session,
    turn,
    assistant,
    calls,
  );
  appendToolResults(session, turn, calls, results);
  return afterTurnGuard(session, contextTokens);
}

/** Run until exclusive finish interception or a truthful incomplete outcome. */
export async function runWorker(
  session: Worker,
): Promise<WorkerOutcome> {
  for (;;) {
    const outcome = await runWorkerTurn(session);
    if (outcome.kind !== 'working') return outcome;
  }
}

/** Complete a tool batch restored from an executing_tool checkpoint.
 * `not_started` resumes at the named call exactly once. `uncertain` never
 * replays the effect boundary: the current and remaining calls receive
 * ordered model-readable errors so the next turn can inspect real state. */
export async function resumePendingToolTurn(
  session: Worker,
  pending: PendingToolTurn,
): Promise<WorkerTurnOutcome> {
  assertRestorablePendingTurn(session, pending);
  throwIfAborted(session.deps.signal);

  let completed = pending.completedResults.map(fromResultBlock);
  if (pending.effect === 'uncertain') {
    const uncertainCall = pending.calls[pending.nextCallIndex]!;
    completed.push(
      generatedErrorResult(
        session.deps.runDir,
        uncertainCall,
        `Recovery did not replay "${uncertainCall.name}" because the prior process ` +
          'crossed its effect boundary without durably recording a result. Its effect is ' +
          'uncertain. Inspect the browser, files, and manifest before deciding what to do.',
      ),
    );
    for (const call of pending.calls.slice(pending.nextCallIndex + 1)) {
      completed.push(
        generatedErrorResult(
          session.deps.runDir,
          call,
          `Not executed during recovery because earlier call "${uncertainCall.name}" ` +
            'has an uncertain effect. Inspect current state in a new turn.',
        ),
      );
    }
    completed = capCombinedResults(session.deps.runDir, pending.calls, completed);
    await session.deps.lifecycle?.afterResult?.(
      pendingToolTurn(
        pending.turn,
        pending.assistant,
        pending.calls,
        completed,
        pending.calls.length,
        'not_started',
      ),
    );
  } else if (pending.nextCallIndex < pending.calls.length) {
    completed = await continueSequentialCalls(
      session,
      pending.turn,
      pending.assistant,
      pending.calls,
      completed,
      pending.nextCallIndex,
    );
  }

  appendToolResults(session, pending.turn, pending.calls, completed);
  return afterTurnGuard(session, session.peakContextTokens);
}

/**
 * Answer deterministic checks or verifier review as the intercepted finish
 * call's own result, preserving one conversation. The model-visible bytes are
 * bounded, transcripted, and charged exactly once before the next turn.
 */
export async function appendFinishResult(
  session: Worker,
  request: FinishRequest,
  content: string,
  isError = true,
): Promise<void> {
  assertPendingFinishCall(session, request);
  const raw: ToolCallResult = isError
    ? {
        toolCallId: request.call.id,
        isError: true,
        errorKind: 'execution_error',
        content: boundGeneratedContent(
          session.deps.runDir,
          FINISH_TOOL_NAME,
          content,
        ),
      }
    : {
        toolCallId: request.call.id,
        isError: false,
        content: boundGeneratedContent(
          session.deps.runDir,
          FINISH_TOOL_NAME,
          content,
        ),
      };
  const [bounded] = capCombinedResults(
    session.deps.runDir,
    [request.call],
    [raw],
  );
  const block = toResultBlock(bounded!);

  session.state.messages.push({ role: 'user', content: [block] });
  session.config.budget.recordToolResultBytes(resultBytes([bounded!]));
  appendTranscriptEvent(session.deps.runDir, {
    type: 'tool_result',
    turn: request.turn,
    result: bounded,
  });
  await session.deps.lifecycle?.finishResultAppended?.({
    session: captureWorkerSnapshot(session),
    request: structuredClone(request),
    result: structuredClone(block),
  });
}

export function readWorkerMetrics(
  session: Worker,
  status: WorkerMetricsStatus,
): WorkerMetrics {
  const roles = session.config.budget.roleUsage();
  const budget = captureRunBudgetSnapshot(session.config.budget);
  const totals = sumRoleUsage(roles);
  return {
    status,
    turns: session.state.turnCount,
    protocolCorrections: session.protocolCorrections,
    ...totals,
    toolCalls: budget.toolCalls,
    toolResultBytes: budget.toolResultBytes,
    peakContextTokens: session.peakContextTokens,
    wallClockMs: now(session) - session.startedMs,
    roles,
  };
}

export function writeWorkerMetrics(
  session: Worker,
  status: WorkerMetricsStatus,
): void {
  const metrics = readWorkerMetrics(session, status);
  writeFileSync(
    join(session.deps.runDir, METRICS_FILENAME),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );
}

export function recordWorkerCrash(
  session: Worker,
  error: unknown,
): void {
  if (session.deps.signal?.aborted === true || isAbortError(error)) return;
  appendTranscriptEvent(session.deps.runDir, {
    type: 'run_error',
    turn: session.state.turnCount,
    message: errorMessage(error),
  });
  writeWorkerMetrics(session, 'failed');
}

async function executeSequentialCalls(
  session: Worker,
  turn: number,
  assistant: AssistantMessage,
  calls: readonly ToolCall[],
): Promise<ToolCallResult[]> {
  return continueSequentialCalls(session, turn, assistant, calls, [], 0);
}

async function continueSequentialCalls(
  session: Worker,
  turn: number,
  assistant: AssistantMessage,
  calls: readonly ToolCall[],
  initialCompleted: readonly ToolCallResult[],
  startIndex: number,
): Promise<ToolCallResult[]> {
  let completed: ToolCallResult[] = [...initialCompleted];

  for (let index = startIndex; index < calls.length; index += 1) {
    throwIfAborted(session.deps.signal);
    const call = calls[index]!;

    let result: ToolCallResult | undefined;
    try {
      await session.deps.lifecycle?.beforeCall?.(
        pendingToolTurn(turn, assistant, calls, completed, index, 'not_started'),
      );
    } catch (error) {
      result = generatedErrorResult(
        session.deps.runDir,
        call,
        `Tool call lifecycle hook failed before "${call.name}"; the tool was ` +
          `not started: ${errorMessage(error)}`,
      );
    }

    if (result === undefined) {
      try {
        // Persist uncertainty before crossing the effect boundary. This is
        // intentionally conservative: a crash after this save never replays
        // a call whose dispatch cannot be disproved.
        await session.deps.lifecycle?.afterDispatch?.(
          pendingToolTurn(turn, assistant, calls, completed, index, 'uncertain'),
        );
      } catch (error) {
        result = generatedErrorResult(
          session.deps.runDir,
          call,
          `Tool call lifecycle hook failed before dispatching "${call.name}"; ` +
            `the tool was not started: ${errorMessage(error)}`,
        );
      }
    }

    if (result === undefined) {
      throwIfAborted(session.deps.signal);
      result = await executeOneCall(session, call);
      throwIfAborted(session.deps.signal);
    }

    completed = capCombinedResults(
      session.deps.runDir,
      calls.slice(0, index + 1),
      [...completed, result],
    );
    await session.deps.lifecycle?.afterResult?.(
      pendingToolTurn(
        turn,
        assistant,
        calls,
        completed,
        index + 1,
        'not_started',
      ),
    );
  }

  return completed;
}

async function executeOneCall(
  session: Worker,
  call: ToolCall,
): Promise<ToolCallResult> {
  const ctx: ToolCtx = {
    runDir: session.deps.runDir,
    ...(session.deps.browser === undefined
      ? {}
      : { browser: session.deps.browser }),
    ...(session.deps.requestPermission === undefined
      ? {}
      : { requestPermission: session.deps.requestPermission }),
    ...(session.deps.signal === undefined
      ? {}
      : { abortSignal: session.deps.signal }),
    busyRegistry: session.busyRegistry,
  };
  try {
    return await executeToolCall(session.deps.registry, call, ctx);
  } catch (error) {
    if (session.deps.signal?.aborted === true || isAbortError(error)) throw error;
    return generatedErrorResult(
      session.deps.runDir,
      call,
      `Tool "${call.name}" failed outside the execution pipeline: ${errorMessage(error)}`,
    );
  }
}

function appendToolResults(
  session: Worker,
  turn: number,
  calls: readonly ToolCall[],
  results: readonly ToolCallResult[],
): void {
  if (calls.length !== results.length) {
    throw new Error(
      `result invariant failed: ${calls.length} calls produced ${results.length} results`,
    );
  }
  const blocks = results.map(toResultBlock);
  session.state.messages.push({ role: 'user', content: blocks });
  session.config.budget.recordToolResultBytes(resultBytes(results));
  results.forEach((result) => {
    appendTranscriptEvent(session.deps.runDir, {
      type: 'tool_result',
      turn,
      result,
    });
  });
}

function pendingToolTurn(
  turn: number,
  assistant: AssistantMessage,
  calls: readonly ToolCall[],
  completed: readonly ToolCallResult[],
  nextCallIndex: number,
  effect: PendingToolTurn['effect'],
): PendingToolTurn {
  return structuredClone({
    turn,
    assistant,
    calls: [...calls],
    completedResults: completed.map(toResultBlock),
    nextCallIndex,
    effect,
  });
}

function capCombinedResults(
  runDir: string,
  calls: readonly ToolCall[],
  results: readonly ToolCallResult[],
): ToolCallResult[] {
  const replacementFloorBytes = 320;
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
    if (largest === -1) break;

    const original = bounded[largest]!;
    if (sizes[largest]! <= replacementFloorBytes) {
      // An offload envelope is larger than a result this small. Skip it and
      // find a result whose replacement can actually shrink the batch.
      offloaded.add(largest);
      continue;
    }
    const safeName = safeToolName(calls[largest]!.name);
    const previewBytes = sizes[largest]! > PREVIEW_MAX_BYTES ? PREVIEW_MAX_BYTES : 0;
    const replacement = JSON.stringify(
      offloadResult(
        runDir,
        safeName,
        original.content,
        `over the ${MAX_TOOL_RESULTS_PER_MESSAGE_BYTES}-byte combined limit for one message's tool results`,
        previewBytes,
      ),
    );
    const replacementBytes = Buffer.byteLength(replacement, 'utf8');
    if (replacementBytes >= sizes[largest]!) {
      throw new Error('offload replacement unexpectedly failed to shrink a result');
    }
    bounded[largest] = { ...original, content: replacement };
    total += replacementBytes - sizes[largest]!;
    sizes[largest] = replacementBytes;
    offloaded.add(largest);
  }

  if (total > MAX_TOOL_RESULTS_PER_MESSAGE_BYTES) {
    throw new Error(
      `combined tool results could not be bounded below ${MAX_TOOL_RESULTS_PER_MESSAGE_BYTES} bytes`,
    );
  }
  return bounded;
}

function generatedErrorResult(
  runDir: string,
  call: ToolCall,
  content: string,
  errorKind: Extract<ToolCallResult, { isError: true }>['errorKind'] =
    'execution_error',
): ToolCallResult {
  return {
    toolCallId: call.id,
    isError: true,
    errorKind,
    content: boundGeneratedContent(runDir, call.name, content),
  };
}

function boundGeneratedContent(
  runDir: string,
  toolName: string,
  content: string,
): string {
  const bounded = capResult(
    runDir,
    safeToolName(toolName),
    content,
    DEFAULT_MAX_RESULT_BYTES,
  );
  return typeof bounded === 'string' ? bounded : JSON.stringify(bounded);
}

function safeToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.length === 0 ? 'unknown_tool' : safe;
}

function formatInvalidInput(
  toolName: string,
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  const details = issues.map((issue) => {
    const path = issue.path.length === 0 ? '(input)' : issue.path.map(String).join('.');
    return `- at ${path}: ${issue.message}`;
  });
  return `Invalid input for tool "${toolName}":\n${details.join('\n')}`;
}

function recordAcceptedResponse(
  session: Worker,
  turn: number,
  response: ModelResponse,
): void {
  appendTranscriptEvent(session.deps.runDir, {
    type: 'model_response',
    turn,
    response,
  });
}

async function recordWorkerModelAccounting(
  session: Worker,
  turn: number,
  usage: Usage,
  wallClockMs: number,
  outcome: ModelAccountingEvent['outcome'],
): Promise<void> {
  session.config.budget.recordModelUsage('worker', usage, wallClockMs);
  await session.deps.lifecycle?.afterModelAccounting?.({
    turn,
    usage: structuredClone(usage),
    outcome,
    session: captureWorkerSnapshot(session),
  });
}

function afterTurnGuard(
  session: Worker,
  contextTokens: number,
): WorkerTurnOutcome {
  const reason = guardReason(session, contextTokens);
  return reason === undefined
    ? { kind: 'working' }
    : { kind: 'incomplete', reason };
}

function guardReason(
  session: Worker,
  contextTokens?: number,
  ignoredLimits: readonly RunBudgetLimit[] = [],
): WorkerGuardReason | undefined {
  const limit = session.config.budget.exceededLimit(ignoredLimits);
  if (limit !== undefined) return budgetReason(limit);
  if (
    contextTokens !== undefined &&
    contextTokens > session.config.maxContextTokens
  ) {
    return 'context_budget';
  }
  return undefined;
}

function budgetReason(limit: RunBudgetLimit): WorkerGuardReason {
  switch (limit) {
    case 'worker_turns':
      return 'max_turns';
    case 'tool_calls':
      return 'tool_calls';
    case 'model_tokens':
      return 'model_tokens';
    case 'wall_time':
      return 'wall_time';
    case 'verifier_corrections':
      return 'verifier_corrections';
  }
}

function requestContextTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function toToolCall(block: ToolUseBlock): ToolCall {
  return { id: block.id, name: block.name, input: block.input };
}

function toResultBlock(result: ToolCallResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

function fromResultBlock(block: ToolResultBlock): ToolCallResult {
  const content =
    typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);
  return block.is_error === true
    ? {
        toolCallId: block.tool_use_id,
        isError: true,
        errorKind: 'execution_error',
        content,
      }
    : { toolCallId: block.tool_use_id, isError: false, content };
}

function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function resultBytes(results: readonly ToolCallResult[]): number {
  return results.reduce(
    (sum, result) => sum + Buffer.byteLength(result.content, 'utf8'),
    0,
  );
}

function sumRoleUsage(
  roles: Partial<Record<string, RunRoleUsage>>,
): Pick<
  WorkerMetrics,
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheCreationInputTokens'
> {
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
  return totals;
}

function assertPendingFinishCall(
  session: Worker,
  request: FinishRequest,
): void {
  if (request.call.name !== FINISH_TOOL_NAME) {
    throw new Error(`expected a ${FINISH_TOOL_NAME} call, got ${request.call.name}`);
  }
  const last = session.state.messages.at(-1);
  const pending =
    last?.role === 'assistant' &&
    last.content.some(
      (block) =>
        block.type === 'tool_use' &&
        block.id === request.call.id &&
        block.name === FINISH_TOOL_NAME,
    );
  if (!pending) {
    throw new Error(
      `finish call ${JSON.stringify(request.call.id)} is not the conversation's unanswered trailing call`,
    );
  }
}

function assertRestorablePendingTurn(
  session: Worker,
  pending: PendingToolTurn,
): void {
  if (pending.turn !== session.state.turnCount) {
    throw new Error(
      `pending tool turn ${pending.turn} does not match session turn ${session.state.turnCount}`,
    );
  }
  const last = session.state.messages.at(-1);
  if (
    last?.role !== 'assistant' ||
    JSON.stringify(last) !== JSON.stringify(pending.assistant)
  ) {
    throw new Error('pending tool turn assistant does not match session history');
  }
  if (
    pending.nextCallIndex < 0 ||
    pending.nextCallIndex > pending.calls.length ||
    pending.completedResults.length !== pending.nextCallIndex
  ) {
    throw new Error('pending tool turn result/index invariant is invalid');
  }
  pending.completedResults.forEach((result, index) => {
    if (result.tool_use_id !== pending.calls[index]?.id) {
      throw new Error('pending tool turn results are not in call order');
    }
  });
  if (
    pending.effect === 'uncertain' &&
    pending.nextCallIndex >= pending.calls.length
  ) {
    throw new Error('pending tool turn cannot be uncertain after its final call');
  }
}

function assertContextCeiling(value: number): void {
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${value}`);
  }
}

function assertSnapshot(snapshot: WorkerSnapshot): void {
  if (snapshot.messages.length === 0) {
    throw new Error('WorkerSnapshot.messages must not be empty');
  }
  assertNonnegativeInteger('turnCount', snapshot.turnCount);
  assertNonnegativeNumber('peakContextTokens', snapshot.peakContextTokens);
  assertNonnegativeInteger('protocolCorrections', snapshot.protocolCorrections);
  if (snapshot.protocolCorrections > MAX_PROTOCOL_CORRECTIONS) {
    throw new Error(
      'WorkerSnapshot.protocolCorrections must be <= ' +
        `${MAX_PROTOCOL_CORRECTIONS}, got ${snapshot.protocolCorrections}`,
    );
  }
  assertNonnegativeNumber('startedMs', snapshot.startedMs);
}

function assertNonnegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`WorkerSnapshot.${name} must be an integer >= 0, got ${value}`);
  }
}

function assertNonnegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`WorkerSnapshot.${name} must be finite and >= 0, got ${value}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(session: Worker): number {
  return (session.deps.now ?? Date.now)();
}
