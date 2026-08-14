import type { ProgressEvent } from '../model/callModel.js';
import type { RunTaskResult } from './runTask.js';

// Pure ProgressEvent/RunTaskResult -> display-text formatting for the T15
// REPL, kept separate from repl.ts's readline glue so it can be tested
// without a terminal, a browser, or the network. repl.ts writes these
// strings straight to stdout as they are produced; nothing here performs
// I/O or buffers state across calls.

/**
 * Render one live model-stream progress event as REPL display text.
 *
 * @param event - one progress event from a single CallModel invocation (see
 *   ProgressEvent): `turn_start` and `turn_end` number the turn from 1,
 *   `tool_use_start` names the tool once the model has chosen it (its input
 *   may still be streaming), `text_delta` carries one fragment of the
 *   model's prose, `retry` reports a transient failure about to be
 *   re-attempted (the preceding prose may show a duplicated fragment — the
 *   retried attempt re-streams the turn; documented wart)
 * @returns display text for this event. `text_delta` returns its fragment
 *   verbatim with no added whitespace, so writing consecutive deltas back
 *   to back reproduces the turn's flowing prose; every other event type
 *   returns one self-contained line that starts and ends with a newline
 */
export function formatProgressEvent(event: ProgressEvent): string {
  switch (event.type) {
    case 'turn_start':
      return `\n--- turn ${event.turn} ---\n`;
    case 'text_delta':
      return event.text;
    case 'tool_use_start':
      return `\n[turn ${event.turn}] tool call: ${event.toolName}\n`;
    case 'retry':
      return (
        `\n[turn ${event.turn}] retrying ${event.attempt}/${event.maxAttempts} ` +
        `in ${(event.delayMs / 1000).toFixed(1)}s — ${event.reason}\n`
      );
    case 'turn_end': {
      const {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
      } = event.usage;
      return (
        `\n[turn ${event.turn}] usage: in=${input_tokens} out=${output_tokens} ` +
        `cache_read=${cache_read_input_tokens ?? 0} ` +
        `cache_write=${cache_creation_input_tokens ?? 0}\n`
      );
    }
  }
}

/**
 * Render a finished run's outcome and location for the REPL, printed once
 * `runTask` resolves and before the session prompts for the next task.
 *
 * @param result - the value `runTask` resolves with: the absolute run
 *   directory plus the harness's terminal outcome (see RunTaskResult) —
 *   `verified` (the only success) or `incomplete` (a reason plus specifics)
 * @returns a multi-line summary — the model's final message on `verified`,
 *   the reason and detail on `incomplete` — followed by the absolute run
 *   directory path, ending in a single trailing newline
 */
export function formatRunSummary(result: RunTaskResult): string {
  const outcome =
    result.status === 'verified'
      ? `verified: ${result.finalText}`
      : `incomplete (${result.reason}): ${result.detail}`;
  return `\n${outcome}\nrun dir: ${result.runDir}\n`;
}
