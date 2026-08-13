import type { ProgressEvent } from '../../src/model/callModel.js';

/** Format attributable, line-oriented progress for concurrent CLI trials. */
export function formatEvalProgress(
  taskName: string,
  trialNumber: number,
  k: number,
  event: ProgressEvent,
): string | undefined {
  const prefix = `[${taskName} ${trialNumber}/${k}]`;
  switch (event.type) {
    case 'text_delta':
      // Concurrent prose fragments are unreadable; the full stream remains
      // durable in transcript.jsonl and tracing.
      return undefined;
    case 'turn_start':
      return `${prefix} turn ${event.turn} started\n`;
    case 'tool_use_start':
      return `${prefix} turn ${event.turn} tool: ${event.toolName}\n`;
    case 'retry':
      return (
        `${prefix} turn ${event.turn} retry ${event.attempt}/${event.maxAttempts} ` +
        `in ${(event.delayMs / 1000).toFixed(1)}s — ${event.reason}\n`
      );
    case 'turn_end':
      return (
        `${prefix} turn ${event.turn} usage: in=${event.usage.input_tokens} ` +
        `out=${event.usage.output_tokens} cache_read=${event.usage.cache_read_input_tokens ?? 0} ` +
        `cache_write=${event.usage.cache_creation_input_tokens ?? 0}\n`
      );
  }
}

export function trialLabel(taskName: string, trialNumber: number, k: number): string {
  return `[${taskName} ${trialNumber}/${k}]`;
}
