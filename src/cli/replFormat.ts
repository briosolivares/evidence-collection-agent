import type { ProgressEvent } from '../model/callModel.js';
import { readManifest } from '../run/artifacts.js';
import type { RunTaskResult } from '../agent/runTask.js';

// ProgressEvent/RunTaskResult -> display-text formatting for the T15 REPL,
// kept separate from repl.ts's readline glue. The finished-run formatter
// reads only the authoritative manifest so published artifacts are not lost
// from an incomplete result; it never reads scratch or transcript state.

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
 * @returns a multi-line human-facing summary, unresolved requirements when
 *   present, manifest-derived published artifact rows, and the absolute run
 *   directory. Internal reason codes and diagnostics stay out of this view.
 */
export function formatRunSummary(result: RunTaskResult): string {
  const lines = [
    '',
    result.status === 'verified' ? 'verified' : 'incomplete',
    result.finalText,
  ];
  if (result.status === 'incomplete' && result.unresolved.length > 0) {
    lines.push('unresolved:');
    for (const item of result.unresolved) {
      lines.push(`- ${item.requirement} — ${item.reason}`);
    }
  }
  const artifacts = publishedArtifactPaths(result.runDir);
  if (artifacts.length > 0) {
    lines.push('artifacts:', ...artifacts.map((path) => `- ${path}`));
  }
  lines.push(`run dir: ${result.runDir}`);
  return `${lines.join('\n')}\n`;
}

/** Read only surfaced manifest entries. A damaged/missing manifest must not
 * hide the run outcome itself, so presentation falls back to no rows. */
function publishedArtifactPaths(runDir: string): string[] {
  try {
    return readManifest(runDir).artifacts
      .filter((entry) => entry.roles !== undefined)
      .map((entry) => entry.filename);
  } catch {
    return [];
  }
}
