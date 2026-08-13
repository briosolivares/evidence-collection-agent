import type Anthropic from '@anthropic-ai/sdk';

import type { AssistantContentBlock, ModelResponse } from '../loop/messages.js';

// Turns the Anthropic streaming wire format back into the loop's
// ModelResponse. Kept separate from the client so the assembly logic — the
// fiddly part of streaming, especially tool_use inputs arriving as partial
// JSON fragments — is a pure function testable against canned event
// fixtures, while the real client just feeds it a live SDK stream.

/** One stream event, exactly as the Anthropic SDK yields them. */
export type ModelStreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/**
 * Fine-grained progress emitted while a response streams in, before the
 * complete ModelResponse exists. `makeCallModel` decorates these with the
 * turn number (see ProgressEvent in callModel.ts).
 */
export type StreamProgressEvent =
  /** A fragment of assistant prose, in stream order; concatenating every
   * text_delta of a response reproduces its text blocks' full text. */
  | { type: 'text_delta'; text: string }
  /** The model started a tool call (its input is still streaming). */
  | { type: 'tool_use_start'; toolName: string };

/** Where and when a stream died, measured from assembly start (which is
 * effectively request dispatch — the first await on the SDK stream). */
export interface TruncatedStreamDiagnostics {
  /** Total time from assembly start to the stream ending, in ms. */
  streamAgeMs: number;
  /** When the first event arrived (~time to first byte); absent if none did. */
  firstEventAtMs?: number;
  /** When the final event arrived, relative to assembly start. */
  lastEventAtMs?: number;
  /** Type of the final event received before the stream ended. */
  lastEventType?: string;
  /** Total events received. */
  eventCount: number;
  /** Characters of generated content received (text + tool-input JSON) —
   * a proxy for output tokens, which the API only reports at message end. */
  outputChars: number;
  /** Human-readable descriptions of blocks still open at stream end. */
  openBlocks: string[];
  /** stop_reason reported by a message_delta before the stream ended, if
   * any — a non-null value on a truncated stream means the server ended
   * the message deliberately (e.g. "refusal"), not a dropped connection. */
  stopReason?: string;
}

/** Render diagnostics as the compact parenthetical used in error messages
 * and retry log lines. */
export function formatTruncationDiagnostics(d: TruncatedStreamDiagnostics): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [`stream age ${sec(d.streamAgeMs)}`];
  parts.push(
    d.firstEventAtMs === undefined ? 'no events received' : `first event +${sec(d.firstEventAtMs)}`,
  );
  if (d.lastEventAtMs !== undefined) {
    parts.push(`last event ${d.lastEventType ?? '?'} +${sec(d.lastEventAtMs)}`);
  }
  parts.push(`${d.eventCount} events`, `~${d.outputChars} output chars`);
  if (d.openBlocks.length > 0) parts.push(`open: ${d.openBlocks.join(', ')}`);
  if (d.stopReason !== undefined) parts.push(`stop_reason ${d.stopReason}`);
  return parts.join(', ');
}

/**
 * Thrown when the event stream ends before describing a complete response —
 * the connection died mid-stream. Distinguished by `name` so retry logic
 * (callWithRetry) can classify truncation as transient without regexing
 * messages; the assembly's deterministic failures (unsupported block type,
 * unparseable tool-input JSON) stay plain Errors, because retrying those
 * would only reproduce them. Carries where-it-died diagnostics so each
 * occurrence (including ones a retry recovers from) is attributable to a
 * regime: died mid-generation vs died before/just after the stream opened.
 */
export class TruncatedStreamError extends Error {
  readonly diagnostics?: TruncatedStreamDiagnostics;
  /** The compact rendering of `diagnostics`, for retry log lines. */
  readonly diagnosticsSummary?: string;

  constructor(message: string, diagnostics?: TruncatedStreamDiagnostics) {
    const summary = diagnostics === undefined ? undefined : formatTruncationDiagnostics(diagnostics);
    super(summary === undefined ? message : `${message} (${summary})`);
    this.name = 'TruncatedStreamError';
    if (diagnostics !== undefined) {
      this.diagnostics = diagnostics;
      this.diagnosticsSummary = summary;
    }
  }
}

/** An in-progress content block, tracked from its start event to its stop
 * event. tool_use inputs accumulate as raw JSON text until the block stops. */
type OpenBlock =
  | { kind: 'text'; block: { type: 'text'; text: string } }
  | { kind: 'tool_use'; block: { type: 'tool_use'; id: string; name: string; input: unknown }; partialJson: string };

/**
 * Assemble one complete ModelResponse from a response's stream of events.
 *
 * @param events - the events of exactly one streamed Messages API response,
 *   in wire order (a live SDK stream or a fixture). Must contain a
 *   message_start, every content block must be closed by a
 *   content_block_stop, a message_delta must have reported a non-null
 *   stop_reason, and a message_stop must arrive before the stream ends —
 *   the full wire shape of a complete response. EOF after closed blocks but
 *   before the terminal message_delta/message_stop is still a truncated
 *   stream: the server never said the response was finished, so treating it
 *   as complete would let a dropped connection masquerade as a short
 *   answer. Throws TruncatedStreamError on any stream that ends early, and
 *   a plain Error on a malformed stream or any content block the loop
 *   cannot carry (anything other than text and tool_use — e.g. thinking
 *   blocks, which the request avoids by disabling thinking)
 * @param onProgress - optional; invoked synchronously for each text
 *   fragment and each tool-call start, in stream order (see
 *   StreamProgressEvent)
 * @returns the response the events describe: content blocks in stream
 *   order with each tool_use input parsed from its accumulated JSON deltas
 *   (an input with no deltas is `{}`), stop_reason as reported (always
 *   non-null — a stream that never reported one is truncated), and usage
 *   taken from the final message_delta where reported, falling back to
 *   message_start values
 */
export async function assembleModelResponse(
  events: AsyncIterable<ModelStreamEvent>,
  onProgress?: (event: StreamProgressEvent) => void,
): Promise<ModelResponse> {
  const content: AssistantContentBlock[] = [];
  const openBlocks = new Map<number, OpenBlock>();
  let startUsage: Anthropic.Messages.Usage | undefined;
  let deltaUsage: Anthropic.Messages.MessageDeltaUsage | undefined;
  let stopReason: string | null = null;
  let sawMessageStop = false;

  const assemblyStart = performance.now();
  let firstEventAtMs: number | undefined;
  let lastEventAtMs: number | undefined;
  let lastEventType: string | undefined;
  let eventCount = 0;
  let outputChars = 0;
  const diagnostics = (): TruncatedStreamDiagnostics => ({
    streamAgeMs: performance.now() - assemblyStart,
    ...(firstEventAtMs === undefined ? {} : { firstEventAtMs }),
    ...(lastEventAtMs === undefined ? {} : { lastEventAtMs }),
    ...(lastEventType === undefined ? {} : { lastEventType }),
    eventCount,
    outputChars,
    openBlocks: [...openBlocks.values()].map((open) =>
      open.kind === 'tool_use'
        ? `${open.block.name}[${open.partialJson.length} chars json]`
        : `text[${open.block.text.length} chars]`,
    ),
    ...(stopReason === null ? {} : { stopReason }),
  });

  for await (const event of events) {
    lastEventAtMs = performance.now() - assemblyStart;
    firstEventAtMs ??= lastEventAtMs;
    lastEventType = event.type;
    eventCount += 1;

    switch (event.type) {
      case 'message_start':
        startUsage = event.message.usage;
        break;

      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text') {
          const open: OpenBlock = { kind: 'text', block: { type: 'text', text: block.text } };
          openBlocks.set(event.index, open);
          content.push(open.block);
          if (block.text !== '') onProgress?.({ type: 'text_delta', text: block.text });
        } else if (block.type === 'tool_use') {
          const open: OpenBlock = {
            kind: 'tool_use',
            block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            partialJson: '',
          };
          openBlocks.set(event.index, open);
          content.push(open.block);
          onProgress?.({ type: 'tool_use_start', toolName: block.name });
        } else {
          // Fail fast: silently dropping a block would corrupt the
          // conversation the loop replays next turn.
          throw new Error(
            `unsupported content block type "${block.type}" in model stream — ` +
              'the loop carries only text and tool_use blocks',
          );
        }
        break;
      }

      case 'content_block_delta': {
        const open = openBlocks.get(event.index);
        if (open === undefined) {
          throw new Error(`content_block_delta for unknown block index ${event.index}`);
        }
        if (event.delta.type === 'text_delta' && open.kind === 'text') {
          open.block.text += event.delta.text;
          outputChars += event.delta.text.length;
          onProgress?.({ type: 'text_delta', text: event.delta.text });
        } else if (event.delta.type === 'input_json_delta' && open.kind === 'tool_use') {
          open.partialJson += event.delta.partial_json;
          outputChars += event.delta.partial_json.length;
        } else {
          throw new Error(
            `unsupported delta type "${event.delta.type}" for a ${open.kind} block at index ${event.index}`,
          );
        }
        break;
      }

      case 'content_block_stop': {
        const open = openBlocks.get(event.index);
        if (open === undefined) {
          throw new Error(`content_block_stop for unknown block index ${event.index}`);
        }
        if (open.kind === 'tool_use') {
          // The API streams tool inputs as JSON text fragments; only the
          // complete concatenation is parseable. No deltas at all means an
          // empty input.
          try {
            open.block.input = open.partialJson === '' ? {} : JSON.parse(open.partialJson);
          } catch {
            throw new Error(
              `tool_use block "${open.block.name}" ended with unparseable input JSON: ${open.partialJson}`,
            );
          }
        }
        openBlocks.delete(event.index);
        break;
      }

      case 'message_delta':
        stopReason = event.delta.stop_reason ?? stopReason;
        deltaUsage = event.usage;
        break;

      case 'message_stop':
        sawMessageStop = true;
        break;
    }
  }

  if (startUsage === undefined) {
    throw new TruncatedStreamError(
      'model stream ended without a message_start event',
      diagnostics(),
    );
  }
  if (openBlocks.size > 0) {
    throw new TruncatedStreamError(
      'model stream ended with unterminated content blocks — response is truncated',
      diagnostics(),
    );
  }
  // Closed blocks alone do not make a complete response: the wire shape
  // ends message_delta (carrying the stop reason) → message_stop, and a
  // stream that dies between block close and those terminal events dropped
  // the connection just like one that dies mid-block.
  if (stopReason === null) {
    throw new TruncatedStreamError(
      'model stream ended without a message_delta reporting a stop reason — response is truncated',
      diagnostics(),
    );
  }
  if (!sawMessageStop) {
    throw new TruncatedStreamError(
      'model stream ended without a message_stop event — response is truncated',
      diagnostics(),
    );
  }

  return {
    content,
    stop_reason: stopReason,
    usage: {
      // message_delta usage is cumulative and authoritative when reported
      // (its fields are nullable); message_start carries the initial counts.
      input_tokens: deltaUsage?.input_tokens ?? startUsage.input_tokens,
      output_tokens: deltaUsage?.output_tokens ?? startUsage.output_tokens,
      cache_read_input_tokens:
        deltaUsage?.cache_read_input_tokens ?? startUsage.cache_read_input_tokens,
      cache_creation_input_tokens:
        deltaUsage?.cache_creation_input_tokens ?? startUsage.cache_creation_input_tokens,
    },
  };
}
