import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  assembleModelResponse,
  type ModelStreamEvent,
  type StreamProgressEvent,
  type TruncatedStreamError,
} from './streamAssembly.js';

// Fixtures are typed as the SDK's own RawMessageStreamEvent so the compiler
// enforces that they match the real wire shapes — a fixture that drifts
// from the API stops compiling instead of silently testing the wrong thing.

/** Replay a canned event list as the async stream the assembler consumes. */
async function* replay(events: readonly ModelStreamEvent[]): AsyncIterable<ModelStreamEvent> {
  for (const event of events) yield event;
}

/** A realistic message_start usage object (all SDK-required fields). */
function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number | null,
  cacheCreationInputTokens: number | null = 0,
): Anthropic.Messages.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    inference_geo: null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
  };
}

function messageStart(startUsage: Anthropic.Messages.Usage): ModelStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_01FixtureFixtureFixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      container: null,
      content: [],
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: startUsage,
    },
  };
}

function messageDelta(
  stopReason: Anthropic.Messages.StopReason,
  deltaUsage: Anthropic.Messages.MessageDeltaUsage,
): ModelStreamEvent {
  return {
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: deltaUsage,
  };
}

// The fiddly case the plan calls out: prose followed by two tool calls,
// with the first tool's input JSON split across deltas at hostile
// boundaries — mid-key, and in the middle of a \n escape sequence — and
// the second tool receiving no input deltas at all (empty input).
const TOOL_INPUT = { file_path: 'limerick.txt', content: 'line one\nline "two"' };
const toolUseTurn: ModelStreamEvent[] = [
  messageStart(usage(1200, 2, 1150)),
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '', citations: null },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing the ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'file now.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_01AAA',
      name: 'write_file',
      input: {},
      caller: { type: 'direct' },
    },
  },
  // JSON.stringify(TOOL_INPUT) === {"file_path":"limerick.txt","content":"line one\nline \"two\""}
  // split mid-key, then between the backslash and the n of the \n escape.
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_p' } },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'ath":"limerick.txt","content":"line one\\' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: 'nline \\"two\\""}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start',
    index: 2,
    content_block: {
      type: 'tool_use',
      id: 'toolu_01BBB',
      name: 'list_files',
      input: {},
      caller: { type: 'direct' },
    },
  },
  { type: 'content_block_stop', index: 2 },
  messageDelta('tool_use', {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1150,
    input_tokens: 1200,
    output_tokens: 96,
    output_tokens_details: null,
    server_tool_use: null,
  }),
  { type: 'message_stop' },
];

describe('assembleModelResponse', () => {
  it('reproduces content blocks and usage exactly, parsing interleaved tool_use JSON deltas', async () => {
    const response = await assembleModelResponse(replay(toolUseTurn));

    expect(response).toEqual({
      content: [
        { type: 'text', text: 'Writing the file now.' },
        { type: 'tool_use', id: 'toolu_01AAA', name: 'write_file', input: TOOL_INPUT },
        { type: 'tool_use', id: 'toolu_01BBB', name: 'list_files', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 1200,
        output_tokens: 96,
        cache_read_input_tokens: 1150,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it('emits progress events in stream order: text deltas and one tool_use_start per call', async () => {
    const seen: StreamProgressEvent[] = [];
    await assembleModelResponse(replay(toolUseTurn), (event) => seen.push(event));

    expect(seen).toEqual([
      { type: 'text_delta', text: 'Writing the ' },
      { type: 'text_delta', text: 'file now.' },
      { type: 'tool_use_start', toolName: 'write_file' },
      { type: 'tool_use_start', toolName: 'list_files' },
    ]);
  });

  it('falls back to message_start usage when message_delta reports null fields', async () => {
    const events: ModelStreamEvent[] = [
      messageStart(usage(87, 3, null)),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', {
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: null,
        output_tokens: 12,
        output_tokens_details: null,
        server_tool_use: null,
      }),
      { type: 'message_stop' },
    ];

    const response = await assembleModelResponse(replay(events));
    expect(response.stop_reason).toBe('end_turn');
    expect(response.usage).toEqual({
      input_tokens: 87,
      output_tokens: 12,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: 0,
    });
  });

  it('captures cache_creation_input_tokens from message_delta when reported', async () => {
    // The moving conversation breakpoint writes a cache extension every
    // turn; its size arrives in the delta usage and must survive assembly.
    const events: ModelStreamEvent[] = [
      messageStart(usage(50, 2, 3000, 0)),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', {
        cache_creation_input_tokens: 2400,
        cache_read_input_tokens: 3000,
        input_tokens: 50,
        output_tokens: 9,
        output_tokens_details: null,
        server_tool_use: null,
      }),
      { type: 'message_stop' },
    ];

    const response = await assembleModelResponse(replay(events));
    expect(response.usage).toEqual({
      input_tokens: 50,
      output_tokens: 9,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 2400,
    });
  });

  it('rejects content the loop cannot carry (a thinking block) instead of dropping it', async () => {
    const events: ModelStreamEvent[] = [
      messageStart(usage(10, 1, null)),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ];

    await expect(assembleModelResponse(replay(events))).rejects.toThrow(/thinking/);
  });

  it('rejects a truncated stream that ends with an unterminated tool_use block', async () => {
    const events: ModelStreamEvent[] = [
      messageStart(usage(10, 1, null)),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01CCC',
          name: 'write_file',
          input: {},
          caller: { type: 'direct' },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_' } },
      // connection drops: no content_block_stop, no message_delta
    ];

    await expect(assembleModelResponse(replay(events))).rejects.toThrow(/unterminated|truncated/);
    // Named for retry classification: truncation is transient (retryable).
    await expect(assembleModelResponse(replay(events))).rejects.toMatchObject({
      name: 'TruncatedStreamError',
    });
    // Carries where-it-died diagnostics: which block was open, how much of
    // its input had arrived, and the compact summary used in retry lines.
    const error = await assembleModelResponse(replay(events)).catch((e: unknown) => e);
    const truncation = error as TruncatedStreamError;
    expect(truncation.diagnostics).toMatchObject({
      eventCount: 3,
      outputChars: '{"file_'.length,
      openBlocks: ['write_file[7 chars json]'],
    });
    expect(truncation.diagnostics!.firstEventAtMs).toBeGreaterThanOrEqual(0);
    expect(truncation.diagnosticsSummary).toContain('open: write_file[7 chars json]');
    expect(truncation.message).toContain('3 events');
  });

  it('rejects a stream with no message_start', async () => {
    await expect(assembleModelResponse(replay([{ type: 'message_stop' }]))).rejects.toThrow(
      /message_start/,
    );
    await expect(assembleModelResponse(replay([{ type: 'message_stop' }]))).rejects.toMatchObject({
      name: 'TruncatedStreamError',
    });
  });

  it('keeps deterministic failures as plain Errors — never TruncatedStreamError', async () => {
    // Retrying an unsupported block or bad tool JSON reproduces it; the
    // retry loop must be able to tell these apart from truncation by name.
    const unsupported: ModelStreamEvent[] = [
      messageStart(usage(10, 1, null)),
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ];
    await expect(assembleModelResponse(replay(unsupported))).rejects.toMatchObject({
      name: 'Error',
    });
  });
});
