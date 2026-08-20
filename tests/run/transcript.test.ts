import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendTranscriptEvent,
  TRANSCRIPT_FILENAME,
  type TranscriptEvent,
} from '../../src/run/transcript.js';

// A temp dir stands in for the run directory; the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readTranscript(): string {
  return readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8');
}

describe('appendTranscriptEvent', () => {
  it('after N appends the file has N lines, each parsing back deep-equal, in order', () => {
    const events: TranscriptEvent[] = [
      { type: 'run_started', task: 'demo task' },
      { type: 'tool_call', name: 'read_file', input: { path: 'a.txt', nested: { n: 1 } } },
      // A newline inside a payload string must not become a second physical line.
      { type: 'note', text: 'line one\nline two' },
    ];
    for (const event of events) {
      appendTranscriptEvent(runDir, event);
    }

    const lines = readTranscript().split('\n');
    // Exactly N content lines plus the trailing newline's empty remainder.
    expect(lines.at(-1)).toBe('');
    const contentLines = lines.slice(0, -1);
    expect(contentLines).toHaveLength(events.length);
    contentLines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(events[i]);
    });
  });

  it('appending never rewrites earlier lines (append-only)', () => {
    appendTranscriptEvent(runDir, { type: 'run_started' });
    appendTranscriptEvent(runDir, { type: 'tool_call', name: 'grep' });
    const before = readTranscript();

    appendTranscriptEvent(runDir, { type: 'run_completed' });

    // Everything previously on disk is still there, byte-for-byte, as a prefix.
    expect(readTranscript().startsWith(before)).toBe(true);
  });
});
