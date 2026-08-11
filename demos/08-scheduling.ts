// Demo for T8: tool scheduling — parallel reads, serialized writes. A fake
// model requests 3 read-only probes and 2 state-changing probes in a single
// turn; the loop hands them to scheduleToolCalls, and instrumented tools
// record when each one ran. The printed timeline shows the three reads
// overlapping (all in flight together) and the two writes running strictly
// one after another, after the read batch — with every result still
// returned in request order.
// Run with: npx tsx demos/08-scheduling.ts

import { z } from 'zod';

import { runAgentLoop } from '../src/loop/agentLoop.js';
import type { ModelResponse } from '../src/loop/messages.js';
import { finalizeManifest, initManifest } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { createRegistry, type ToolDef } from '../src/tools/registry.js';

const TASK = 'Probe three sources in parallel, then apply two changes in order.';

/** One recorded execution: when the probe started and finished, in ms
 * relative to the start of the run. */
interface Span {
  label: string;
  kind: 'read' | 'write';
  startMs: number;
  endMs: number;
}

const spans: Span[] = [];
const runStartedMs = Date.now();

const probeInput = z.object({ label: z.string(), delayMs: z.number() });

/** An instrumented probe tool: idles `delayMs`, recording its span. */
function probeTool(name: string, kind: 'read' | 'write'): ToolDef {
  const tool: ToolDef<z.infer<typeof probeInput>> = {
    name,
    description: `Instrumented ${kind} probe: idles delayMs and reports back.`,
    inputSchema: probeInput,
    readOnly: kind === 'read',
    execute: async ({ label, delayMs }) => {
      const startMs = Date.now() - runStartedMs;
      await new Promise((wake) => setTimeout(wake, delayMs));
      spans.push({ label, kind, startMs, endMs: Date.now() - runStartedMs });
      return `${label} done after ${delayMs}ms`;
    },
  };
  return tool as ToolDef;
}

// The single scripted turn: 3 reads then 2 writes, one response. The reads
// are deliberately slow enough that serial execution would be obvious
// (~240ms serial vs ~80ms parallel); the writes must serialize regardless.
const script: ModelResponse[] = [
  {
    content: [
      { type: 'text', text: 'Probing all three sources, then applying both changes.' },
      { type: 'tool_use', id: 'r1', name: 'probe_read', input: { label: 'read-A', delayMs: 80 } },
      { type: 'tool_use', id: 'r2', name: 'probe_read', input: { label: 'read-B', delayMs: 60 } },
      { type: 'tool_use', id: 'r3', name: 'probe_read', input: { label: 'read-C', delayMs: 100 } },
      { type: 'tool_use', id: 'w1', name: 'probe_write', input: { label: 'write-1', delayMs: 60 } },
      { type: 'tool_use', id: 'w2', name: 'probe_write', input: { label: 'write-2', delayMs: 60 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 900, output_tokens: 120 },
  },
  {
    content: [{ type: 'text', text: 'All probes and changes done.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1100, output_tokens: 30, cache_read_input_tokens: 850 },
  },
];

let served = 0;
async function callModel(): Promise<ModelResponse> {
  const response = script[served];
  if (response === undefined) {
    throw new Error('fake model script exhausted — the loop should have stopped');
  }
  served += 1;
  return response;
}

/** Render one span as a bar on a shared ms-scaled axis. */
function bar(span: Span, totalMs: number, width: number): string {
  const from = Math.round((span.startMs / totalMs) * width);
  const to = Math.max(from + 1, Math.round((span.endMs / totalMs) * width));
  const lane = ' '.repeat(from) + '█'.repeat(to - from) + ' '.repeat(width - to);
  const kind = span.kind === 'read' ? 'read ' : 'write';
  return `${kind}  ${span.label.padEnd(8)} |${lane}| ${String(span.startMs).padStart(4)}–${span.endMs}ms`;
}

const registry = createRegistry([probeTool('probe_read', 'read'), probeTool('probe_write', 'write')]);
const runDir = createRunDir('runs', generateRunId('demo scheduling'));
initManifest(runDir, TASK);
console.log(`run dir: ${runDir}`);
console.log(`task:    ${TASK}\n`);

const result = await runAgentLoop(TASK, { callModel, registry, runDir }, {
  maxTurns: 3,
  maxTokens: 100_000,
});
finalizeManifest(runDir);

console.log(`result: ${JSON.stringify(result)}\n`);

// The timeline, in request order: the three read bars overlap, the two
// write bars start only after the reads settle and never overlap each other.
const totalMs = Math.max(...spans.map((span) => span.endMs));
const byRequestOrder = ['read-A', 'read-B', 'read-C', 'write-1', 'write-2'];
console.log(`--- timeline (0–${totalMs}ms) ---`);
for (const label of byRequestOrder) {
  const span = spans.find((candidate) => candidate.label === label);
  if (span === undefined) throw new Error(`probe ${label} never ran`);
  console.log(bar(span, totalMs, 48));
}

const reads = spans.filter((span) => span.kind === 'read');
const writes = spans
  .filter((span) => span.kind === 'write')
  .sort((left, right) => left.startMs - right.startMs);
const readsOverlap = Math.max(...reads.map((span) => span.startMs)) < Math.min(...reads.map((span) => span.endMs));
const writesSerialized = writes.every(
  (span, index) => index === 0 || span.startMs >= writes[index - 1].endMs,
);
console.log(`\nreads overlapped:   ${readsOverlap} (all three in flight at once)`);
console.log(`writes serialized:  ${writesSerialized} (each starts after the previous finishes)`);
