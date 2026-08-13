// Scripted Anthropic raw-stream fixtures for bridge tests: build the wire
// events of one streamed response, exactly as the SDK would yield them.

import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';

/** Usage numbers for one scripted response. */
export interface ScriptedUsage {
  input: number;
  output: number;
  cacheRead?: number;
}

/** One scripted content block. */
export type ScriptedBlock =
  | { type: 'text'; text: string; /** chunk size for deltas */ chunk?: number }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Build the raw event sequence for one complete streamed response. */
export function scriptedResponse(
  blocks: ScriptedBlock[],
  usage: ScriptedUsage,
  stopReason = 'end_turn',
): ModelStreamEvent[] {
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: usage.input,
          output_tokens: 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
        },
      },
    },
  ];

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      const chunk = block.chunk ?? 8;
      for (let offset = 0; offset < block.text.length; offset += chunk) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text.slice(offset, offset + chunk) },
        });
      }
      events.push({ type: 'content_block_stop', index });
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      events.push({ type: 'content_block_stop', index });
    }
  });

  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { input_tokens: null, output_tokens: usage.output },
  });
  events.push({ type: 'message_stop' });
  return events as ModelStreamEvent[];
}

/** Turn an event array into the async iterable the bridge consumes. */
export async function* streamOf(
  events: readonly ModelStreamEvent[],
): AsyncIterable<ModelStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * A stream factory that serves one scripted response per model call, in
 * order, and records the params/signal of each call.
 */
export function scriptedStreamFactory(responses: ModelStreamEvent[][]) {
  const calls: { params: unknown; signal: AbortSignal | undefined }[] = [];
  let next = 0;
  return {
    calls,
    createStream: (params: unknown, signal: AbortSignal | undefined) => {
      calls.push({ params, signal });
      const events = responses[next];
      if (events === undefined) {
        throw new Error(`scripted stream exhausted after ${next} calls`);
      }
      next += 1;
      return streamOf(events);
    },
  };
}
