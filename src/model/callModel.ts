import Anthropic from '@anthropic-ai/sdk';

import type { CallModel, Message, Usage } from '../loop/messages.js';
import type { ApiToolDef } from '../tools/registry.js';
import { callWithRetry } from './callWithRetry.js';
import { assembleModelResponse } from './streamAssembly.js';

// The production deps.callModel: the real Anthropic client behind the same
// CallModel contract the T7 fake satisfies, so it drops into the loop
// unchanged. Three properties matter here and are tested directly:
//
// 1. Stable prompt prefix. The API renders requests as tools → system →
//    messages, and prompt caching is a byte-exact prefix match — so system
//    prompt + tool definitions must serialize identically on every call,
//    with a cache_control breakpoint on the last (only) system block,
//    which caches tools and system together. Only `messages` varies.
// 2. Moving conversation breakpoint. A second cache_control marker rides
//    the last content block of the last message on every request, so turn
//    N+1 resumes from the cache entry turn N wrote: the whole conversation
//    is read at cache rates instead of being re-paid as fresh input each
//    turn. One message-level marker only, matching Claude Code — the
//    server evicts cache pages past the marker, so a second one would pin
//    pages nothing resumes from. Exactly 2 breakpoints per request (API
//    max 4). Caveat (documented, not guarded): the server matches cached
//    prefixes up to 20 content blocks back from a marker, so a single turn
//    appending more than 20 blocks would silently miss; our turns append
//    two messages with at most ~12 blocks (5-parallel tool cap).
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
  | { type: 'retry'; turn: number; attempt: number; delayMs: number; reason: string }
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
 *   of the last message (the marked message is a clone; `messages` and its
 *   blocks are never mutated), so each turn's request resumes from the
 *   cache entry the previous turn wrote — see the file header. All earlier
 *   messages pass through untouched. Thinking is explicitly disabled: on
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
    system: [
      {
        type: 'text',
        text: config.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: withConversationBreakpoint(messages),
  };
}

/** A content block that may carry a cache_control marker. The loop's block
 * types (text, tool_use, tool_result) all accept one; this local widening
 * spares a per-variant switch. */
type MarkableBlockParam = Anthropic.Messages.ContentBlockParam & {
  cache_control?: Anthropic.Messages.CacheControlEphemeral | null;
};

/**
 * The conversation as API message params, with the moving cache breakpoint
 * on the last content block of the last message. The marked message and
 * block are clones — the input array (owned by the loop, logged live to
 * the transcript) is never mutated, and all earlier messages pass through
 * as-is. An empty conversation or an empty final message (neither of which
 * the loop produces) passes through unmarked: the marker is an
 * optimization, never worth a throw.
 */
function withConversationBreakpoint(
  messages: readonly Message[],
): Anthropic.Messages.MessageParam[] {
  // The loop's message shapes mirror the API's on purpose (see
  // messages.ts) — they are structurally valid MessageParams.
  const params = messages.map((message) => message as Anthropic.Messages.MessageParam);
  const last = params[params.length - 1];
  if (last === undefined || typeof last.content === 'string') return params;
  const lastBlock = last.content[last.content.length - 1];
  if (lastBlock === undefined) return params;

  params[params.length - 1] = {
    ...last,
    content: [
      ...last.content.slice(0, -1),
      { ...lastBlock, cache_control: { type: 'ephemeral' } } as MarkableBlockParam,
    ],
  };
  return params;
}

/**
 * Create the production CallModel: a closure over an Anthropic client and
 * the fixed prompt configuration.
 *
 * @param config - see CallModelConfig; the returned function sends
 *   config.system + config.apiToolDefs as the stable cached prefix on
 *   every call. Credentials come from the environment (ANTHROPIC_API_KEY,
 *   or the SDK's other ambient sources) — calls fail without them
 * @returns a CallModel that streams every request, assembles the complete
 *   ModelResponse from the stream (content blocks including tool_use
 *   inputs, stop_reason, usage including cache_read_input_tokens), retries
 *   transient failures across the whole create-and-consume span (see
 *   callWithRetry; retry attempts surface as `retry` progress events), and
 *   reports progress through config.onProgress (see ProgressEvent),
 *   numbering turns from 1 across its own invocations. The messages
 *   argument is never mutated
 */
export function makeCallModel(config: CallModelConfig): CallModel {
  const client = makeAnthropicClient();
  let turnCount = 0;

  return async (messages) => {
    turnCount += 1;
    const turn = turnCount;
    config.onProgress?.({ type: 'turn_start', turn });

    // The retry span covers stream creation AND consumption: mid-stream
    // failures (SSE error events, dropped connections) throw out of the
    // assembly iteration, and only re-creating the stream retries them.
    const response = await callWithRetry(
      async () => {
        const stream = client.messages.stream(buildRequestParams(config, messages));
        return await assembleModelResponse(stream, (event) => {
          if (event.type === 'text_delta') {
            config.onProgress?.({ type: 'text_delta', turn, text: event.text });
          } else {
            config.onProgress?.({ type: 'tool_use_start', turn, toolName: event.toolName });
          }
        });
      },
      { onRetry: (info) => config.onProgress?.({ type: 'retry', turn, ...info }) },
    );

    config.onProgress?.({ type: 'turn_end', turn, usage: response.usage });
    return response;
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
