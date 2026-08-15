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
} from '../../loop/messages.js';
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
} from '../tools/finish.js';
import { buildV3ContextView } from './contextView.js';

export const V3_METRICS_FILENAME = 'metrics.json';
export const V3_MAX_PROTOCOL_CORRECTIONS = 3;

export const V3_NO_TOOL_CONTINUATION =
  'Continue working with tools, or call finish alone when the requested work is ready.';

export interface V3WorkerSessionDeps {
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
  lifecycle?: V3WorkerLifecycleHooks;
  /** Test/metrics seam. Budget wall time remains owned by RunBudgetTracker. */
  now?: () => number;
}

export interface V3WorkerSessionConfig {
  /** One unresettable tracker shared with initializer/verifier roles. */
  budget: RunBudgetTracker;
  /** Maximum tokens in one accepted request/response context, or Infinity. */
  maxContextTokens: number;
}

export interface V3WorkerSessionOpeningOptions {
  /** Per-run contract/resume facts; each remains a separate opening text block. */
  guidance?: readonly string[];
}

export interface V3WorkerSessionState {
  /** Full, never-collapsed conversation. */
  messages: Message[];
  /** Logical worker model calls, including rejected responses. */
  turnCount: number;
}

export interface V3WorkerSession {
  readonly deps: V3WorkerSessionDeps;
  readonly config: V3WorkerSessionConfig;
  readonly state: V3WorkerSessionState;
  readonly startedMs: number;
  readonly busyRegistry: BusyResourceRegistry;
  peakContextTokens: number;
  protocolCorrections: number;
}

export interface V3WorkerSessionSnapshot {
  messages: Message[];
  turnCount: number;
  peakContextTokens: number;
  protocolCorrections: number;
  startedMs: number;
}

export interface V3PendingToolTurn {
  turn: number;
  assistant: AssistantMessage;
  calls: ToolCall[];
  completedResults: ToolResultBlock[];
  nextCallIndex: number;
  effect: 'not_started' | 'uncertain';
}

export interface V3BeforeModelRequestEvent {
  turn: number;
  session: V3WorkerSessionSnapshot;
  /** Pure collapsed request view; never aliases changed blocks into state. */
  messages: readonly Message[];
}

export interface V3FinishRequest {
  turn: number;
  call: ToolCall;
  input: FinishInput;
  assistantText: string;
}

/**
 * Durable-state boundaries. Hooks receive defensive snapshots and cannot
 * mutate the live session. `afterDispatch` is conservatively awaited at the
 * dispatch boundary before the executor is invoked: once it succeeds, a
 * checkpoint may truthfully call the effect uncertain. A failure from either
 * pre-effect hook prevents execution and becomes that call's own error.
 * `afterResult` and finish-hook failures are post-effect persistence failures
 * and propagate terminally; they are never disguised as retryable tool errors.
 */
export interface V3WorkerLifecycleHooks {
  beforeModelRequest?(event: V3BeforeModelRequestEvent): Promise<void>;
  beforeCall?(pending: V3PendingToolTurn): Promise<void>;
  afterDispatch?(pending: V3PendingToolTurn): Promise<void>;
  afterResult?(pending: V3PendingToolTurn): Promise<void>;
  finishRequested?(event: {
    session: V3WorkerSessionSnapshot;
    request: V3FinishRequest;
  }): Promise<void>;
  finishResultAppended?(event: {
    session: V3WorkerSessionSnapshot;
    request: V3FinishRequest;
    result: ToolResultBlock;
  }): Promise<void>;
}

export type V3WorkerGuardReason =
  | 'max_turns'
  | 'context_budget'
  | 'tool_calls'
  | 'model_tokens'
  | 'tool_result_bytes'
  | 'wall_time'
  | 'verifier_corrections';

export type V3WorkerIncompleteReason =
  | V3WorkerGuardReason
  | 'model_rejected'
  | 'model_rejection_limit';

export type V3WorkerTurnOutcome =
  | { kind: 'working' }
  | { kind: 'finish_requested'; request: V3FinishRequest }
  | {
      kind: 'incomplete';
      reason: V3WorkerIncompleteReason;
      modelRejection?: ModelRejectionReason;
      detail?: string;
    };

export type V3WorkerSessionOutcome = Exclude<
  V3WorkerTurnOutcome,
  { kind: 'working' }
>;

export type V3WorkerMetricsStatus =
  | 'verified'
  | 'incomplete'
  | 'failed'
  | 'cancelled';

export interface V3WorkerMetrics {
  status: V3WorkerMetricsStatus;
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

export function createV3WorkerSession(
  taskText: string,
  deps: V3WorkerSessionDeps,
  config: V3WorkerSessionConfig,
  options: V3WorkerSessionOpeningOptions = {},
): V3WorkerSession {
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

export function captureV3WorkerSessionSnapshot(
  session: V3WorkerSession,
): V3WorkerSessionSnapshot {
  return {
    messages: structuredClone(session.state.messages),
    turnCount: session.state.turnCount,
    peakContextTokens: session.peakContextTokens,
    protocolCorrections: session.protocolCorrections,
    startedMs: session.startedMs,
  };
}

export function restoreV3WorkerSession(
  snapshot: V3WorkerSessionSnapshot,
  deps: V3WorkerSessionDeps,
  config: V3WorkerSessionConfig,
): V3WorkerSession {
  assertContextCeiling(config.maxContextTokens);
  assertV3Snapshot(snapshot);
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

export function appendV3WorkerFeedback(
  session: V3WorkerSession,
  feedback: string,
): void {
  session.state.messages.push({
    role: 'user',
    content: [{ type: 'text', text: feedback }],
  });
}

/** Remove only a trailing assistant turn whose tool uses have no answer. */
export function dropV3UnansweredAssistantTurn(session: V3WorkerSession): boolean {
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
export async function runV3WorkerTurn(
  session: V3WorkerSession,
): Promise<V3WorkerTurnOutcome> {
  throwIfAborted(session.deps.signal);
  const existingGuard = guardReason(session);
  if (existingGuard !== undefined) {
    return { kind: 'incomplete', reason: existingGuard };
  }

  const turn = session.state.turnCount + 1;
  const requestMessages = buildV3ContextView(session.state.messages);
  await session.deps.lifecycle?.beforeModelRequest?.({
    turn,
    session: captureV3WorkerSessionSnapshot(session),
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
    accepted = await session.deps.model.generate({
      messages: requestMessages,
      ...(session.deps.signal === undefined
        ? {}
        : { signal: session.deps.signal }),
      ...(session.deps.onModelEvent === undefined
        ? {}
        : { onEvent: session.deps.onModelEvent }),
    });
  } catch (error) {
    throwIfAborted(session.deps.signal);
    const knownUsage = knownModelUsageFromError(error);
    if (knownUsage !== undefined) {
      session.config.budget.recordModelUsage(
        'worker',
        knownUsage,
        now(session) - startedMs,
      );
    }
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
      if (session.protocolCorrections >= V3_MAX_PROTOCOL_CORRECTIONS) {
        return {
          kind: 'incomplete',
          reason: 'model_rejection_limit',
          modelRejection: error.reason,
          detail: error.message,
        };
      }
      session.protocolCorrections += 1;
      appendV3WorkerFeedback(session, error.protocolFeedback);
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

  throwIfAborted(session.deps.signal);
  const response = accepted.response;
  session.config.budget.recordModelUsage(
    'worker',
    accepted.usage,
    now(session) - startedMs,
  );
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
    appendV3WorkerFeedback(session, V3_NO_TOOL_CONTINUATION);
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

    const request: V3FinishRequest = {
      turn,
      call: structuredClone(call),
      input: parsed.data,
      assistantText,
    };
    appendTranscriptEvent(session.deps.runDir, {
      type: 'finish_requested',
      turn,
      input: request.input,
    });
    await session.deps.lifecycle?.finishRequested?.({
      session: captureV3WorkerSessionSnapshot(session),
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
export async function runV3WorkerSession(
  session: V3WorkerSession,
): Promise<V3WorkerSessionOutcome> {
  for (;;) {
    const outcome = await runV3WorkerTurn(session);
    if (outcome.kind !== 'working') return outcome;
  }
}

/**
 * Answer deterministic checks or verifier review as the intercepted finish
 * call's own result, preserving one conversation. The model-visible bytes are
 * bounded, transcripted, and charged exactly once before the next turn.
 */
export async function appendV3FinishResult(
  session: V3WorkerSession,
  request: V3FinishRequest,
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
    session: captureV3WorkerSessionSnapshot(session),
    request: structuredClone(request),
    result: structuredClone(block),
  });
}

export function readV3WorkerMetrics(
  session: V3WorkerSession,
  status: V3WorkerMetricsStatus,
): V3WorkerMetrics {
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

export function writeV3WorkerMetrics(
  session: V3WorkerSession,
  status: V3WorkerMetricsStatus,
): void {
  const metrics = readV3WorkerMetrics(session, status);
  writeFileSync(
    join(session.deps.runDir, V3_METRICS_FILENAME),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );
}

export function recordV3WorkerCrash(
  session: V3WorkerSession,
  error: unknown,
): void {
  if (session.deps.signal?.aborted === true || isAbortError(error)) return;
  appendTranscriptEvent(session.deps.runDir, {
    type: 'run_error',
    turn: session.state.turnCount,
    message: errorMessage(error),
  });
  writeV3WorkerMetrics(session, 'failed');
}

async function executeSequentialCalls(
  session: V3WorkerSession,
  turn: number,
  assistant: AssistantMessage,
  calls: readonly ToolCall[],
): Promise<ToolCallResult[]> {
  let completed: ToolCallResult[] = [];

  for (let index = 0; index < calls.length; index += 1) {
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
  session: V3WorkerSession,
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
  session: V3WorkerSession,
  turn: number,
  calls: readonly ToolCall[],
  results: readonly ToolCallResult[],
): void {
  if (calls.length !== results.length) {
    throw new Error(
      `v3 result invariant failed: ${calls.length} calls produced ${results.length} results`,
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
  effect: V3PendingToolTurn['effect'],
): V3PendingToolTurn {
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
      throw new Error('v3 offload replacement unexpectedly failed to shrink a result');
    }
    bounded[largest] = { ...original, content: replacement };
    total += replacementBytes - sizes[largest]!;
    sizes[largest] = replacementBytes;
    offloaded.add(largest);
  }

  if (total > MAX_TOOL_RESULTS_PER_MESSAGE_BYTES) {
    throw new Error(
      `v3 combined tool results could not be bounded below ${MAX_TOOL_RESULTS_PER_MESSAGE_BYTES} bytes`,
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
  session: V3WorkerSession,
  turn: number,
  response: ModelResponse,
): void {
  appendTranscriptEvent(session.deps.runDir, {
    type: 'model_response',
    turn,
    response,
  });
}

function afterTurnGuard(
  session: V3WorkerSession,
  contextTokens: number,
): V3WorkerTurnOutcome {
  const reason = guardReason(session, contextTokens);
  return reason === undefined
    ? { kind: 'working' }
    : { kind: 'incomplete', reason };
}

function guardReason(
  session: V3WorkerSession,
  contextTokens?: number,
): V3WorkerGuardReason | undefined {
  const limit = session.config.budget.exceededLimit();
  if (limit !== undefined) return budgetReason(limit);
  if (
    contextTokens !== undefined &&
    contextTokens > session.config.maxContextTokens
  ) {
    return 'context_budget';
  }
  return undefined;
}

function budgetReason(limit: RunBudgetLimit): V3WorkerGuardReason {
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
  V3WorkerMetrics,
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
  session: V3WorkerSession,
  request: V3FinishRequest,
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

function assertContextCeiling(value: number): void {
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`maxContextTokens must be >= 0, got ${value}`);
  }
}

function assertV3Snapshot(snapshot: V3WorkerSessionSnapshot): void {
  if (snapshot.messages.length === 0) {
    throw new Error('V3WorkerSessionSnapshot.messages must not be empty');
  }
  assertNonnegativeInteger('turnCount', snapshot.turnCount);
  assertNonnegativeNumber('peakContextTokens', snapshot.peakContextTokens);
  assertNonnegativeInteger('protocolCorrections', snapshot.protocolCorrections);
  if (snapshot.protocolCorrections > V3_MAX_PROTOCOL_CORRECTIONS) {
    throw new Error(
      'V3WorkerSessionSnapshot.protocolCorrections must be <= ' +
        `${V3_MAX_PROTOCOL_CORRECTIONS}, got ${snapshot.protocolCorrections}`,
    );
  }
  assertNonnegativeNumber('startedMs', snapshot.startedMs);
}

function assertNonnegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`V3WorkerSessionSnapshot.${name} must be an integer >= 0, got ${value}`);
  }
}

function assertNonnegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`V3WorkerSessionSnapshot.${name} must be finite and >= 0, got ${value}`);
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

function now(session: V3WorkerSession): number {
  return (session.deps.now ?? Date.now)();
}
