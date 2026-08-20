import type Anthropic from '@anthropic-ai/sdk';

import { errorMessage, isAbortError } from '../errors.js';
import type { Message, ModelResponse, ToolUseBlock, Usage } from './messages.js';
import type { ApiToolDef } from '../tools/registry.js';
import { buildRequestParams, makeAnthropicClient } from './callModel.js';
import { callWithRetry } from './callWithRetry.js';
import { assembleModelResponse, type ModelStreamEvent } from './streamAssembly.js';

// The one strict, cancellable driver every model role runs behind. No
// model content reaches conversation history or tool execution until the
// whole stream has been accepted: assembled to completion (streamAssembly
// now requires the terminal message_delta and message_stop) and validated
// for execution (stop reason, content shape, tool-call structure, per-turn
// tool-call cap). A response that fails validation is rejected as a whole —
// the caller never sees its content, so it can never enter history or run
// tools — and surfaces as a typed ModelResponseRejectedError carrying a
// short protocol correction the worker loop may relay.
//
// Retry layers, from inside out:
// 1. callWithRetry — transport failures and truncated streams, unchanged.
// 2. The driver's own single max_tokens retry: one structurally complete
//    response cut off by the output limit is re-asked as the *same request*
//    with a configured, larger max_tokens. The first attempt is discarded
//    entirely; at most one such retry per generate() call.

/** Default per-response cap on tool_use blocks. Generous relative to the
 * scheduler's 5-wide read parallelism — the cap exists to reject runaway
 * responses (dozens of calls from a confused model), not to tune batching. */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 16;

/** Stop-reason labels that permit execution: the model finished its turn,
 * wants tools to run, or hit a caller-supplied stop sequence. Everything
 * else — max_tokens, refusal, model_context_window_exceeded, pause_turn,
 * labels this code has never heard of — fails closed. */
export type AcceptedStopReason = 'end_turn' | 'tool_use' | 'stop_sequence';

const ACCEPTED_STOP_REASONS: readonly string[] = ['end_turn', 'tool_use', 'stop_sequence'];

/** Why a structurally complete response was rejected for execution. */
export type ModelRejectionReason =
  /** The output-token limit cut the response off (after the driver's one
   * enlarged retry, when configured). */
  | 'max_tokens'
  /** The model refused to answer (stop_reason "refusal"). */
  | 'refusal'
  /** The request overflowed the model's context window. */
  | 'context_exhausted'
  /** The response reported no stop reason at all. */
  | 'missing_stop_reason'
  /** A stop-reason label this driver does not recognize — fail closed. */
  | 'unknown_stop_reason'
  /** A content block other than text or tool_use. */
  | 'unsupported_content'
  /** A tool_use block with a missing id/name, a non-object input, or a
   * duplicate id. */
  | 'malformed_tool_call'
  /** More tool_use blocks than maxToolCallsPerTurn allows. */
  | 'too_many_tool_calls';

/** Rejection reasons the worker itself can plausibly fix on the next turn
 * when told what went wrong; everything else is terminal for the call. */
export function isProtocolCorrectableRejection(reason: ModelRejectionReason): boolean {
  return (
    reason === 'too_many_tool_calls' || reason === 'malformed_tool_call' || reason === 'max_tokens'
  );
}

/**
 * A whole model response rejected before history or execution. `reason`
 * classifies it; `protocolFeedback` is a short, model-facing correction a
 * loop may append (without the rejected content) when the reason is
 * protocol-correctable; `usage` carries the rejected attempt's token
 * accounting so budgets can still charge for it.
 */
export class ModelResponseRejectedError extends Error {
  override readonly name = 'ModelResponseRejectedError';
  readonly reason: ModelRejectionReason;
  readonly protocolFeedback: string;
  readonly usage?: Usage;

  constructor(
    reason: ModelRejectionReason,
    message: string,
    protocolFeedback: string,
    usage?: Usage,
  ) {
    super(message);
    this.reason = reason;
    this.protocolFeedback = protocolFeedback;
    if (usage !== undefined) this.usage = usage;
  }
}

/** Classified by name, not instanceof, so copies across module graphs (and
 * test doubles) classify identically — the same convention callWithRetry
 * uses for TruncatedStreamError. */
export function isModelResponseRejectedError(error: unknown): error is ModelResponseRejectedError {
  return error instanceof Error && error.name === 'ModelResponseRejectedError';
}

/** A fatal model failure that happened after an earlier complete response in
 * the same logical generate call had already reported billable usage. The
 * original failure remains available as `cause`; no partial response content
 * is exposed or accepted. */
export class ModelGenerationFailedError extends Error {
  override readonly name = 'ModelGenerationFailedError';
  readonly usage: Usage;

  constructor(cause: unknown, usage: Usage) {
    super(`model generation failed after an earlier billable attempt: ${errorMessage(cause)}`, {
      cause,
    });
    this.usage = usage;
  }
}

export function isModelGenerationFailedError(error: unknown): error is ModelGenerationFailedError {
  return error instanceof Error && error.name === 'ModelGenerationFailedError';
}

/** Usage known for a failed logical model call, when the provider reported
 * any. Callers use this one seam so rejected responses and fatal retry
 * failures cannot drift into different accounting rules. */
export function knownModelUsageFromError(error: unknown): Usage | undefined {
  if (isModelResponseRejectedError(error)) return error.usage;
  if (isModelGenerationFailedError(error)) return error.usage;
  return undefined;
}

/** A response the driver accepted: safe to append to history and execute. */
export interface AcceptedModelResponse {
  /** The complete assembled response. */
  response: ModelResponse;
  /** Its stop reason, narrowed to the accepted labels. */
  stopReason: AcceptedStopReason;
  /** Stream attempts this generate() consumed, counting transport retries
   * and the max_tokens re-ask. */
  attempts: number;
  /** Known billable usage across every structurally complete response in
   * this logical generate call. Usually identical to `response.usage`; when
   * a max_tokens response was discarded and re-asked, it includes both the
   * discarded attempt and the accepted replacement so one worker turn does
   * not hide the first attempt's spend. Truncated transport attempts still
   * cannot contribute usage because no complete usage record exists. */
  usage: Usage;
}

/** Execution-validation limits; validated finite at driver construction. */
export interface ModelExecutionLimits {
  /** Reject any response containing more tool_use blocks than this;
   * a finite integer >= 1. */
  maxToolCallsPerTurn: number;
}

/**
 * Validate one assembled response for history and execution. Accepts a
 * normal end/tool/stop-sequence stop label with well-formed text/tool_use
 * content within the tool-call cap; rejects everything else by throwing
 * ModelResponseRejectedError. Pure — usable on any ModelResponse, whatever
 * produced it.
 */
export function validateModelResponseForExecution(
  response: ModelResponse,
  limits: ModelExecutionLimits,
): Omit<AcceptedModelResponse, 'attempts' | 'usage'> {
  assertValidToolCallLimit(limits.maxToolCallsPerTurn);
  const reject = (
    reason: ModelRejectionReason,
    message: string,
    protocolFeedback: string,
  ): never => {
    throw new ModelResponseRejectedError(reason, message, protocolFeedback, response.usage);
  };

  const stop = response.stop_reason;
  if (stop === null) {
    reject(
      'missing_stop_reason',
      'model response reported no stop reason',
      'Your previous response was discarded because it did not complete. Continue the task.',
    );
  } else if (stop === 'max_tokens') {
    reject(
      'max_tokens',
      'model response was cut off by the output-token limit',
      'Your previous response was discarded: it exceeded the output limit and was cut off. ' +
        'Respond again more concisely — use fewer, smaller steps per turn.',
    );
  } else if (stop === 'refusal') {
    reject(
      'refusal',
      'model refused to continue (stop_reason "refusal")',
      'Your previous response was discarded because it was refused.',
    );
  } else if (stop === 'model_context_window_exceeded') {
    reject(
      'context_exhausted',
      'model context window was exhausted (stop_reason "model_context_window_exceeded")',
      'The conversation no longer fits the model context window.',
    );
  } else if (!ACCEPTED_STOP_REASONS.includes(stop)) {
    reject(
      'unknown_stop_reason',
      `model response ended with unrecognized stop_reason "${stop}"`,
      'Your previous response was discarded because it ended abnormally. Continue the task.',
    );
  }

  const toolUses: ToolUseBlock[] = [];
  for (const block of response.content) {
    if (block.type === 'text') continue;
    if (block.type !== 'tool_use') {
      reject(
        'unsupported_content',
        `model response contains an unsupported "${(block as { type: string }).type}" content block`,
        'Your previous response was discarded because it contained unsupported content. ' +
          'Respond with prose and tool calls only.',
      );
    }
    toolUses.push(block);
  }

  const seenIds = new Set<string>();
  for (const toolUse of toolUses) {
    const malformed =
      typeof toolUse.id !== 'string' ||
      toolUse.id === '' ||
      typeof toolUse.name !== 'string' ||
      toolUse.name === '' ||
      typeof toolUse.input !== 'object' ||
      toolUse.input === null ||
      Array.isArray(toolUse.input);
    if (malformed) {
      reject(
        'malformed_tool_call',
        `model response contains a malformed tool_use block (name "${String(toolUse.name)}")`,
        'Your previous response was discarded because a tool call was malformed. ' +
          'Issue each tool call with its documented input object.',
      );
    }
    if (seenIds.has(toolUse.id)) {
      reject(
        'malformed_tool_call',
        `model response contains duplicate tool_use id "${toolUse.id}"`,
        'Your previous response was discarded because it reused a tool call id. ' +
          'Issue each tool call once.',
      );
    }
    seenIds.add(toolUse.id);
  }

  if (toolUses.length > limits.maxToolCallsPerTurn) {
    reject(
      'too_many_tool_calls',
      `model response requested ${toolUses.length} tool calls, over the ` +
        `${limits.maxToolCallsPerTurn}-call per-turn limit`,
      'Your previous response was discarded: it requested too many tool calls at once. ' +
        `Respond again with at most ${limits.maxToolCallsPerTurn} tool calls per turn.`,
    );
  }

  return { response, stopReason: stop as AcceptedStopReason };
}

/**
 * Fine-grained lifecycle of one generate() call, keyed by attempt. Every
 * stream creation — first try, transport retry, the max_tokens re-ask —
 * gets a fresh attemptId, so a display can render deltas per attempt and
 * discard any attempt that never reaches attempt_accepted. Exactly one
 * attempt_accepted ends a successful call; a failed call ends with
 * attempt_rejected (validation) or a thrown transport error instead.
 */
export type ModelAttemptEvent =
  | { type: 'attempt_start'; attemptId: number }
  | { type: 'text_delta'; attemptId: number; text: string }
  | { type: 'tool_use_start'; attemptId: number; toolName: string }
  | {
      type: 'retry';
      attemptId: number;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'attempt_rejected'; attemptId: number; reason: ModelRejectionReason; message: string }
  | { type: 'attempt_accepted'; attemptId: number; usage: Usage };

/** One model call's inputs: the conversation, cancellation, progress. */
export interface ModelGenerateOptions {
  /** The conversation so far; never mutated. */
  messages: readonly Message[];
  /** Cancels streaming and retry backoff alike. */
  signal?: AbortSignal;
  /** Attempt-scoped progress (see ModelAttemptEvent). */
  onEvent?: (event: ModelAttemptEvent) => void;
}

/** The strict model driver: one generate() per turn, whole-response
 * acceptance or a typed rejection — never partial content. */
export interface ModelDriver {
  generate(options: ModelGenerateOptions): Promise<AcceptedModelResponse>;
}

/** Everything createAnthropicModelDriver closes over. system + apiToolDefs
 * form the cached prompt prefix and are fixed for the driver's lifetime. */
export interface ModelDriverConfig {
  /** Model id; callModel's DEFAULT_MODEL when omitted. */
  model?: string;
  /** The system prompt, sent verbatim on every call. */
  system: string;
  /** The API tools array (already deterministic). */
  apiToolDefs: readonly ApiToolDef[];
  /** max_tokens for each response; a finite integer >= 1. */
  maxOutputTokens: number;
  /** The larger allowance for the single same-request retry after a
   * structurally complete max_tokens response; a finite integer >
   * maxOutputTokens. Defaults to 2 × maxOutputTokens. */
  maxTokensRetryOutputTokens?: number;
  /** Per-response tool-call cap; a finite integer >= 1. Defaults to
   * DEFAULT_MAX_TOOL_CALLS_PER_TURN. */
  maxToolCallsPerTurn?: number;
  /** Forces the model's tool use on every call (see CallModelConfig). Part
   * of the cached prefix, so it is fixed for the driver's lifetime. */
  toolChoice?: Anthropic.Messages.ToolChoice;
  /** Test seam: produces one response's raw event stream. The default
   * creates an Anthropic SDK stream carrying the abort signal (the client
   * is constructed lazily so a missing API key fails the first generate,
   * not driver construction). */
  createStream?: (
    params: Anthropic.Messages.MessageStreamParams,
    signal: AbortSignal | undefined,
  ) => AsyncIterable<ModelStreamEvent>;
}

function assertFinitePositiveInteger(name: string, value: number): void {
  // Number.isInteger rejects NaN and ±Infinity outright, so a nonsense
  // limit can never survive to bypass a comparison downstream.
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a finite integer >= 1, got ${value}`);
  }
}

function assertValidToolCallLimit(value: number): void {
  assertFinitePositiveInteger('maxToolCallsPerTurn', value);
}

/**
 * Create the production ModelDriver over the Anthropic streaming API.
 * Validates every limit at construction (NaN/Infinity throw here, not
 * mid-run). Each generate(): build the request (buildRequestParams — same
 * byte-stable prefix and cache breakpoints as always), stream and assemble
 * it under callWithRetry with the caller's AbortSignal, then validate for
 * execution. A structurally complete max_tokens response is retried exactly
 * once as the same request with maxTokensRetryOutputTokens; the first
 * attempt's content is discarded and never returned.
 */
export function createAnthropicModelDriver(config: ModelDriverConfig): ModelDriver {
  assertFinitePositiveInteger('maxOutputTokens', config.maxOutputTokens);
  const retryOutputTokens = config.maxTokensRetryOutputTokens ?? config.maxOutputTokens * 2;
  if (!Number.isInteger(retryOutputTokens) || retryOutputTokens <= config.maxOutputTokens) {
    throw new Error(
      `maxTokensRetryOutputTokens must be a finite integer > maxOutputTokens ` +
        `(${config.maxOutputTokens}), got ${retryOutputTokens}`,
    );
  }
  const maxToolCallsPerTurn = config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  assertValidToolCallLimit(maxToolCallsPerTurn);

  let client: Anthropic | undefined;
  const createStream =
    config.createStream ??
    ((params: Anthropic.Messages.MessageStreamParams, signal: AbortSignal | undefined) => {
      client ??= makeAnthropicClient();
      return client.messages.stream(params, signal === undefined ? undefined : { signal });
    });

  return {
    async generate(options: ModelGenerateOptions): Promise<AcceptedModelResponse> {
      const emit = options.onEvent ?? (() => {});
      let attempts = 0;
      const knownUsages: Usage[] = [];

      const streamOnce = (maxTokens: number): Promise<ModelResponse> =>
        callWithRetry(
          async () => {
            attempts += 1;
            const attemptId = attempts;
            emit({ type: 'attempt_start', attemptId });
            const params = buildRequestParams(
              {
                ...(config.model === undefined ? {} : { model: config.model }),
                system: config.system,
                apiToolDefs: config.apiToolDefs,
                maxOutputTokens: maxTokens,
                ...(config.toolChoice === undefined ? {} : { toolChoice: config.toolChoice }),
              },
              options.messages,
            );
            const stream = createStream(params, options.signal);
            return await assembleModelResponse(stream, (event) => {
              if (event.type === 'text_delta') {
                emit({ type: 'text_delta', attemptId, text: event.text });
              } else {
                emit({ type: 'tool_use_start', attemptId, toolName: event.toolName });
              }
            });
          },
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onRetry: (info) => emit({ type: 'retry', attemptId: attempts, ...info }),
          },
        );

      const accept = (response: ModelResponse): AcceptedModelResponse => {
        const attemptId = attempts;
        knownUsages.push(response.usage);
        try {
          const validated = validateModelResponseForExecution(response, { maxToolCallsPerTurn });
          const usage = aggregateUsage(knownUsages);
          emit({ type: 'attempt_accepted', attemptId, usage });
          return { ...validated, attempts, usage };
        } catch (error) {
          if (isModelResponseRejectedError(error)) {
            emit({
              type: 'attempt_rejected',
              attemptId,
              reason: error.reason,
              message: error.message,
            });
          }
          throw error;
        }
      };

      const first = await streamOnce(config.maxOutputTokens);
      try {
        return accept(first);
      } catch (error) {
        // Exactly one enlarged re-ask, only for a structurally complete
        // max_tokens response, and only when cancellation hasn't landed.
        // The first attempt is already discarded: it was never returned,
        // so no caller can have appended it to history.
        if (
          !isModelResponseRejectedError(error) ||
          error.reason !== 'max_tokens' ||
          options.signal?.aborted === true
        ) {
          throw error;
        }
      }
      let second: ModelResponse;
      try {
        second = await streamOnce(retryOutputTokens);
      } catch (error) {
        // Cancellation must retain its conventional error shape. All other
        // failures preserve the transport/assembly error as `cause` while
        // carrying the first complete attempt's already-reported usage.
        if (isAbortError(error)) throw error;
        options.signal?.throwIfAborted();
        throw new ModelGenerationFailedError(error, aggregateUsage(knownUsages));
      }
      try {
        return accept(second);
      } catch (error) {
        if (isModelResponseRejectedError(error)) {
          throw new ModelResponseRejectedError(
            error.reason,
            error.message,
            error.protocolFeedback,
            aggregateUsage(knownUsages),
          );
        }
        throw error;
      }
    },
  };
}

/** Sum usage the provider reported for complete responses in one logical
 * generate call. Optional cache counters remain absent only when every
 * constituent usage omitted them; null contributes no tokens. */
function aggregateUsage(usages: readonly Usage[]): Usage {
  const optionalSum = (
    field: 'cache_read_input_tokens' | 'cache_creation_input_tokens',
  ): number | undefined => {
    let seen = false;
    let total = 0;
    for (const usage of usages) {
      const value = usage[field];
      if (value === undefined || value === null) continue;
      seen = true;
      total += value;
    }
    return seen ? total : undefined;
  };

  const cacheRead = optionalSum('cache_read_input_tokens');
  const cacheCreation = optionalSum('cache_creation_input_tokens');
  return {
    input_tokens: usages.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: usages.reduce((sum, usage) => sum + usage.output_tokens, 0),
    ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
  };
}
