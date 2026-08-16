import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Name of the transcript file inside every run directory. */
export const TRANSCRIPT_FILENAME = 'transcript.jsonl';

/**
 * One loop event as recorded in the transcript: a `type` discriminator
 * naming what happened, plus whatever payload fields that event carries.
 */
export interface TranscriptEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Append one event to the run's transcript.
 *
 * @param runDir - absolute path to an existing, writable run directory
 * @param event - a JSON-serializable event; throws (writing nothing) if it
 *   cannot be serialized
 * @returns nothing; the event is appended to <runDir>/transcript.jsonl as
 *   exactly one new line of JSON that parses back to a deep-equal copy —
 *   lines already in the file are never modified (append-only)
 */
export function appendTranscriptEvent(runDir: string, event: TranscriptEvent): void {
  // Serialize before touching the file so a non-serializable event (e.g. a
  // circular structure) fails without corrupting the transcript.
  const line = JSON.stringify(event);
  appendFileSync(join(runDir, TRANSCRIPT_FILENAME), `${line}\n`, 'utf8');
}
