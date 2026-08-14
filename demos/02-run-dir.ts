// Demo for T2: create a run directory, append three transcript events,
// and print the transcript back cat-style.
// Run with: npx tsx demos/02-run-dir.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateRunId } from '../src/run/runId.js';
import { createRunDir, resolveRunPath } from '../src/run/runDir.js';
import { appendTranscriptEvent, TRANSCRIPT_FILENAME } from '../src/run/transcript.js';

const runDir = createRunDir('runs', generateRunId('demo run-dir'));
console.log(`created run dir: ${runDir}`);

appendTranscriptEvent(runDir, { type: 'run_started', task: 'demo: exercise the transcript' });
appendTranscriptEvent(runDir, {
  type: 'tool_call',
  name: 'observe',
  input: { need: ['interactive'] },
});
appendTranscriptEvent(runDir, { type: 'run_completed', turns: 1 });

// The confinement chokepoint at work: a nested path resolves, an escape throws.
console.log(`\nresolveRunPath('sub/notes.txt') -> ${resolveRunPath(runDir, 'sub/notes.txt')}`);
try {
  resolveRunPath(runDir, '../escape.txt');
} catch (err) {
  console.log(`resolveRunPath('../escape.txt') -> threw: ${(err as Error).message}`);
}

const transcriptPath = join(runDir, TRANSCRIPT_FILENAME);
console.log(`\n$ cat ${transcriptPath}`);
process.stdout.write(readFileSync(transcriptPath, 'utf8'));
