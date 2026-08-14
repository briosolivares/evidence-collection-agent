import Anthropic from '@anthropic-ai/sdk';

import { isCollapsedStub } from '../loop/contextView.js';
import type { CallModel, Message, Usage } from '../loop/messages.js';
import type { ApiToolDef } from '../tools/registry.js';
import { createAnthropicModelDriver, type ModelDriverConfig } from './modelDriver.js';

// The production deps.callModel: the real Anthropic client behind the same
// CallModel contract the T7 fake satisfies, so it drops into the loop
// unchanged. Three properties matter here and are tested directly:
//
// 1. Stable prompt prefix. The API renders requests as tools → system →
//    messages, and prompt caching is a byte-exact prefix match — so system
//    prompt + tool definitions must serialize identically on every call,
//    with a cache_control breakpoint on the last (only) system block,
//    which caches tools and system together. Only `messages` varies.
// 2. Moving conversation breakpoints. A cache_control marker rides the
//    last content block of the last message on every request, so turn N+1
//    resumes from the cache entry turn N wrote: the whole conversation is
//    read at cache rates instead of being re-paid as fresh input each
//    turn. A second marker rides the collapse frontier — the newest
//    observe stub in the API message view (see loop/contextView.ts).
//    It exists because the server matches cached prefixes only up to ~20
//    content blocks back from a marker: when a new observation stubs the
//    third-most-recent one, the request diverges at that stub — usually
//    far more than 20 blocks before the tip — and without a marker there
//    the whole conversation misses and is re-paid at cache-write rates
//    (measured live: every displacement turn re-wrote ~full context,
//    1.07M cache-write tokens on a 62k-context run). Consecutive
//    frontiers sit a couple of messages apart, so each displacement turn
//    resumes from the previous frontier's entry instead. At most 3
//    breakpoints per request (API max 4). Caveat (documented, not
//    guarded): a single turn appending more than 20 blocks would still
//    silently miss at the tip; our turns append two messages with at most
//    ~12 blocks (5-parallel tool cap).
// 3. Always streaming. Long tool-filled turns can run for minutes;
//    streaming avoids API timeouts and feeds live progress to the REPL.

/** Model used when the config names none — the design's default (Sonnet
 * tier matches the deployment reality being evaluated against). */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Live progress emitted while a turn streams, for interactive surfaces
 * (the T15 REPL). Per turn, events arrive in this order: one `turn_start`;
 * then `text_delta` and `tool_use_start` events in stream order (the
 * concatenated text_delta texts reproduce the turn's prose; one
 * tool_use_start per tool call, when its name is known but its input is
 * still streaming); then one `turn_end` carrying the turn's usage. `turn`
 * counts this CallModel's invocations from 1.
 *
 * A `retry` event may appear anywhere between `turn_start` and `turn_end`:
 * a transient failure killed the attempt and callWithRetry is about to run
 * attempt `attempt` after `delayMs`. Known cosmetic wart, documented not
 * fixed: the failed attempt may already have streamed partial text_deltas,
 * so a display can show a duplicated sentence fragment before the retry
 * line — the successful attempt re-streams the turn from the top.
 */
export type ProgressEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; turn: number; text: string }
  | { type: 'tool_use_start'; turn: number; toolName: string }
  | { type: 'retry'; turn: number; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: 'turn_end'; turn: number; usage: Usage };

/** Everything makeCallModel closes over. The system prompt and tool
 * definitions form the cached prompt prefix, so they are fixed for the
 * closure's lifetime — a new prompt or tool set means a new CallModel. */
export interface CallModelConfig {
  /** Model id; DEFAULT_MODEL when omitted. */
  model?: string;
  /** The system prompt, sent verbatim on every call. */
  system: string;
  /** The API tools array, from toApiToolDefs (already deterministic). */
  apiToolDefs: readonly ApiToolDef[];
  /** max_tokens for each response; a positive integer. */
  maxOutputTokens: number;
  /** Optional live-progress callback (see ProgressEvent). */
  onProgress?: (event: ProgressEvent) => void;
  /** Forces the model's tool use for every call — used by roles whose
   * response IS a single tool call (the contract initializer). Part of the
   * cached prefix, so it must stay fixed for the closure's lifetime. */
  toolChoice?: Anthropic.Messages.ToolChoice;
  /** Cancellation carried into streaming and retry backoff. */
  signal?: AbortSignal;
  /** Per-response tool-call cap; the driver's default when omitted. */
  maxToolCallsPerTurn?: number;
  /** Larger allowance for the driver's single max_tokens re-ask. */
  maxTokensRetryOutputTokens?: number;
  /** Test seam passed through to the driver (see ModelDriverConfig). */
  createStream?: ModelDriverConfig['createStream'];
}

/**
 * Build the streaming request parameters for one model call.
 *
 * @param config - the fixed per-run configuration (see CallModelConfig)
 * @param messages - the conversation so far; not mutated
 * @returns parameters for a streamed Messages API call in which system
 *   prompt and tools form the stable prefix: for a fixed config their
 *   serialization is byte-identical across calls regardless of `messages`
 *   (nothing dynamic — timestamps, ids — enters them), and the single
 *   system block carries the `cache_control` breakpoint that ends the
 *   prefix (the API renders tools before system, so it caches both). A
 *   second, moving `cache_control` breakpoint rides the last content block
 *   of the last message, and a third rides the collapse frontier — the
 *   newest inspect_page stub — when the view contains one (marked
 *   messages are clones; `messages` and its blocks are never mutated), so
 *   each turn's request resumes from a previous turn's cache entry even
 *   when collapsing edited a message mid-conversation — see the file header.
 *   All other messages pass through untouched. Thinking is explicitly disabled: on
 *   claude-sonnet-5 it defaults to on, but thinking blocks must be
 *   replayed verbatim in later turns and the loop's message types (text
 *   and tool_use only) cannot carry them — which also means every block a
 *   marker can land on (text, tool_use, tool_result) accepts one.
 */
export function buildRequestParams(
  config: CallModelConfig,
  messages: readonly Message[],
): Anthropic.Messages.MessageStreamParams {
  return {
    model: config.model ?? DEFAULT_MODEL,
    max_tokens: config.maxOutputTokens,
    thinking: { type: 'disabled' },
    tools: config.apiToolDefs.map((def) => ({
      name: def.name,
      description: def.description,
      // ApiToolDef carries the schema as a plain object; the API requires
      // (and toApiToolDefs produces) a top-level {type: "object"} schema.
      input_schema: def.input_schema as Anthropic.Messages.Tool.InputSchema,
    })),
    ...(config.toolChoice === undefined ? {} : { tool_choice: config.toolChoice }),
    system: [
      {
        type: 'text',
        text: config.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: withConversationBreakpoints(messages),
  };
}

/** A content block that may carry a cache_control marker. The loop's block
 * types (text, tool_use, tool_result) all accept one; this local widening
 * spares a per-variant switch. */
type MarkableBlockParam = Anthropic.Messages.ContentBlockParam & {
  cache_control?: Anthropic.Messages.CacheControlEphemeral | null;
};

/** A block's place in the conversation, for cache marker placement. */
interface BlockPosition {
  messageIndex: number;
  blockIndex: number;
}

/**
 * The conversation as API message params, with the moving cache
 * breakpoints in place: one on the last content block of the last message
 * (the tip), and one on the collapse frontier when the view contains
 * inspect_page stubs (see the file header for why). Marked messages and
 * blocks are clones — the input array (owned by the loop, logged live to
 * the transcript) is never mutated, and all other messages pass through
 * as-is. An empty conversation or an empty final message (neither of which
 * the loop produces) passes through unmarked: the markers are an
 * optimization, never worth a throw.
 */
function withConversationBreakpoints(
  messages: readonly Message[],
): Anthropic.Messages.MessageParam[] {
  // The loop's message shapes mirror the API's on purpose (see
  // messages.ts) — they are structurally valid MessageParams.
  const params = messages.map((message) => message as Anthropic.Messages.MessageParam);
  const tip = tipPosition(messages);
  const frontier = frontierPosition(messages);
  // A frontier that IS the tip block gets one marker, not two.
  const frontierIsTip =
    frontier !== undefined &&
    tip !== undefined &&
    frontier.messageIndex === tip.messageIndex &&
    frontier.blockIndex === tip.blockIndex;
  for (const position of frontierIsTip ? [tip] : [frontier, tip]) {
    if (position === undefined) continue;
    const message = params[position.messageIndex]!;
    if (typeof message.content === 'string') continue;
    const content = [...message.content];
    content[position.blockIndex] = {
      ...content[position.blockIndex]!,
      cache_control: { type: 'ephemeral' },
    } as MarkableBlockParam;
    params[position.messageIndex] = { ...message, content };
  }
  return params;
}

/** The tip: the last content block of the last message. */
function tipPosition(messages: readonly Message[]): BlockPosition | undefined {
  const messageIndex = messages.length - 1;
  const blockIndex = (messages[messageIndex]?.content.length ?? 0) - 1;
  return blockIndex < 0 ? undefined : { messageIndex, blockIndex };
}

/** The collapse frontier: the newest inspect_page stub in the view — the
 * block where a displacement turn's request diverges from the previous
 * turn's, and therefore where its cache entry must end. */
function frontierPosition(messages: readonly Message[]): BlockPosition | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    if (message.role !== 'user') continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      if (isCollapsedStub(message.content[blockIndex]!)) return { messageIndex, blockIndex };
    }
  }
  return undefined;
}

/**
 * Create the production CallModel: a temporary adapter over the strict
 * ModelDriver (createAnthropicModelDriver), kept so existing call sites
 * keep their CallModel seam while callers migrate to the driver directly.
 *
 * @param config - see CallModelConfig; the returned function sends
 *   config.system + config.apiToolDefs as the stable cached prefix on
 *   every call. Credentials come from the environment (ANTHROPIC_API_KEY,
 *   or the SDK's other ambient sources) — calls fail without them
 * @returns a CallModel that streams every request through the shared
 *   driver: the complete ModelResponse is assembled (strictly — the
 *   terminal message_delta/message_stop are required), transient failures
 *   retry across the whole create-and-consume span (surfacing as `retry`
 *   progress events), one structurally complete max_tokens response is
 *   re-asked once with a larger allowance, and every returned response has
 *   passed validateModelResponseForExecution — a truncated, refused, or
 *   malformed response rejects (ModelResponseRejectedError) instead of
 *   returning. Progress arrives through config.onProgress (see
 *   ProgressEvent), turns numbered from 1 across invocations. The messages
 *   argument is never mutated
 */
export function makeCallModel(config: CallModelConfig): CallModel {
  const driver = createAnthropicModelDriver({
    ...(config.model === undefined ? {} : { model: config.model }),
    system: config.system,
    apiToolDefs: config.apiToolDefs,
    maxOutputTokens: config.maxOutputTokens,
    ...(config.maxToolCallsPerTurn === undefined
      ? {}
      : { maxToolCallsPerTurn: config.maxToolCallsPerTurn }),
    ...(config.maxTokensRetryOutputTokens === undefined
      ? {}
      : { maxTokensRetryOutputTokens: config.maxTokensRetryOutputTokens }),
    ...(config.createStream === undefined ? {} : { createStream: config.createStream }),
    ...(config.toolChoice === undefined ? {} : { toolChoice: config.toolChoice }),
  });
  let turnCount = 0;

  return async (messages) => {
    turnCount += 1;
    const turn = turnCount;
    config.onProgress?.({ type: 'turn_start', turn });

    const accepted = await driver.generate({
      messages,
      ...(config.signal === undefined ? {} : { signal: config.signal }),
      onEvent: (event) => {
        // Attempt-scoped driver events map onto the legacy turn-scoped
        // ProgressEvents; a rejected attempt's deltas may already have
        // streamed (the documented cosmetic wart) but its content is never
        // returned, so nothing rejected can be committed downstream.
        if (event.type === 'text_delta') {
          config.onProgress?.({ type: 'text_delta', turn, text: event.text });
        } else if (event.type === 'tool_use_start') {
          config.onProgress?.({ type: 'tool_use_start', turn, toolName: event.toolName });
        } else if (event.type === 'retry') {
          config.onProgress?.({
            type: 'retry',
            turn,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
          });
        }
      },
    });

    config.onProgress?.({ type: 'turn_end', turn, usage: accepted.response.usage });
    return accepted.response;
  };
}

/**
 * The Anthropic client every production call site constructs: SDK
 * auto-retry disabled so callWithRetry is the single retry authority
 * (matching Claude Code). Nested SDK retries would multiply ours — up to
 * 12 requests for one turn — and the SDK's retry covers only the initial
 * POST anyway, not stream consumption. Credentials come from the
 * environment (ANTHROPIC_API_KEY, or the SDK's other ambient sources);
 * construction throws without them.
 */
export function makeAnthropicClient(): Anthropic {
  return new Anthropic({ maxRetries: 0 });
}
