import Anthropic from '@anthropic-ai/sdk';

import type { CallModel, Message, Usage } from '../loop/messages.js';
import type { ApiToolDef } from '../tools/registry.js';
import { assembleModelResponse } from './streamAssembly.js';

// The production deps.callModel: the real Anthropic client behind the same
// CallModel contract the T7 fake satisfies, so it drops into the loop
// unchanged. Two properties matter here and are tested directly:
//
// 1. Stable prompt prefix. The API renders requests as tools → system →
//    messages, and prompt caching is a byte-exact prefix match — so system
//    prompt + tool definitions must serialize identically on every call,
//    with the cache_control breakpoint on the last (only) system block,
//    which caches tools and system together. Only `messages` varies.
// 2. Always streaming. Long tool-filled turns can run for minutes;
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
 */
export type ProgressEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; turn: number; text: string }
  | { type: 'tool_use_start'; turn: number; toolName: string }
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
 *   prefix (the API renders tools before system, so it caches both).
 *   Thinking is explicitly disabled: on claude-sonnet-5 it defaults to on,
 *   but thinking blocks must be replayed verbatim in later turns and the
 *   loop's message types (text and tool_use only) cannot carry them.
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
    // The loop's message shapes mirror the API's on purpose (see
    // messages.ts) — they are structurally valid MessageParams.
    messages: messages.map((message) => message as Anthropic.Messages.MessageParam),
  };
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
 *   inputs, stop_reason, usage including cache_read_input_tokens), and
 *   reports progress through config.onProgress (see ProgressEvent),
 *   numbering turns from 1 across its own invocations. The messages
 *   argument is never mutated
 */
export function makeCallModel(config: CallModelConfig): CallModel {
  const client = new Anthropic();
  let turnCount = 0;

  return async (messages) => {
    turnCount += 1;
    const turn = turnCount;
    config.onProgress?.({ type: 'turn_start', turn });

    const stream = client.messages.stream(buildRequestParams(config, messages));
    const response = await assembleModelResponse(stream, (event) => {
      if (event.type === 'text_delta') {
        config.onProgress?.({ type: 'text_delta', turn, text: event.text });
      } else {
        config.onProgress?.({ type: 'tool_use_start', turn, toolName: event.toolName });
      }
    });

    config.onProgress?.({ type: 'turn_end', turn, usage: response.usage });
    return response;
  };
}
