// Demo for T7: the complete agent loop driven by a scripted fake model —
// zero tokens spent. The fake plays a "write a haiku to haiku.txt, verify
// it, finish" script; the loop executes the real file tools through the
// real pipeline against a real run directory. Afterwards the run's durable
// records are shown: transcript.jsonl (replayed), manifest.json, metrics.json.
// Run with: npx tsx demos/07-loop-fake-model.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METRICS_FILENAME, runAgentLoop } from '../src/loop/agentLoop.js';
import type { ModelResponse } from '../src/loop/messages.js';
import { finalizeManifest, initManifest, MANIFEST_FILENAME } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { TRANSCRIPT_FILENAME } from '../src/run/transcript.js';
import { fileTools } from '../src/tools/index.js';
import { createRegistry } from '../src/tools/registry.js';

const TASK = 'Write a haiku about evidence collection to haiku.txt, then finish.';

const HAIKU = ['Quiet browser hums —', 'the agent saves what it saw,', 'hashes keep it true.', ''].join(
  '\n',
);

// The scripted run: write the haiku, read it back to verify, then finish
// with a plain-text response (no tool_use = the completion signal). The
// stop_reason labels and usage numbers are fake but API-shaped; note the
// cache_read_input_tokens from turn 2 on, as a real cached run would show.
const script: ModelResponse[] = [
  {
    content: [
      { type: 'text', text: 'Composing the haiku and writing it to haiku.txt.' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'write_file',
        input: { file_path: 'haiku.txt', content: HAIKU },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1200, output_tokens: 90 },
  },
  {
    content: [
      { type: 'text', text: 'Verifying the file before finishing.' },
      { type: 'tool_use', id: 'call-2', name: 'read_file', input: { file_path: 'haiku.txt' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1320, output_tokens: 70, cache_read_input_tokens: 1150 },
  },
  {
    content: [{ type: 'text', text: 'haiku.txt is written and verified. Done.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1400, output_tokens: 40, cache_read_input_tokens: 1150 },
  },
];

let served = 0;
async function callModel(): Promise<ModelResponse> {
  const response = script[served];
  if (response === undefined) {
    throw new Error('fake model script exhausted — the loop should have stopped');
  }
  served += 1;
  console.log(`\n=== turn ${served} ===`);
  for (const block of response.content) {
    if (block.type === 'text') console.log(`assistant: ${block.text}`);
    else console.log(`tool call: ${block.name} ${clip(JSON.stringify(block.input))}`);
  }
  return response;
}

/** Keep printed payloads to one readable line. */
function clip(text: string, max = 88): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One compact line per transcript event. */
function summarize(event: Record<string, any>): string {
  switch (event.type) {
    case 'model_request':
      return `model_request   turn ${event.turn}  (${event.messages.length} messages)`;
    case 'model_response': {
      const kinds = event.response.content.map((block: { type: string }) => block.type).join(', ');
      return `model_response  turn ${event.turn}  [${kinds}]  stop_reason=${event.response.stop_reason}`;
    }
    case 'tool_call':
      return `tool_call       turn ${event.turn}  ${event.call.name} ${clip(JSON.stringify(event.call.input), 60)}`;
    case 'tool_result': {
      const label = event.result.isError ? 'error' : 'ok';
      return `tool_result     turn ${event.turn}  ${label}: ${clip(event.result.content.split('\n')[0], 60)}`;
    }
    default:
      return `${event.type}`;
  }
}

const registry = createRegistry(fileTools);
const runDir = createRunDir('runs', generateRunId('demo loop-fake-model'));
initManifest(runDir, TASK);
console.log(`run dir: ${runDir}`);
console.log(`task:    ${TASK}`);

const result = await runAgentLoop(TASK, { callModel, registry, runDir }, {
  maxTurns: 5,
  maxContextTokens: 100_000,
});
finalizeManifest(runDir);

console.log(`\nresult after ${served} turns: ${JSON.stringify(result)}`);

console.log('\n--- transcript.jsonl (replayed) ---');
for (const line of readFileSync(join(runDir, TRANSCRIPT_FILENAME), 'utf8').trimEnd().split('\n')) {
  console.log(summarize(JSON.parse(line) as Record<string, any>));
}

console.log('\n--- haiku.txt ---');
console.log(readFileSync(join(runDir, 'haiku.txt'), 'utf8'));

console.log('--- manifest.json ---');
console.log(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'));

console.log('--- metrics.json ---');
console.log(readFileSync(join(runDir, METRICS_FILENAME), 'utf8'));
