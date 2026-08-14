// Demo for T8 (V2): tool scheduling by CONCRETE ACCESS KEY, not by a
// blanket read/write category. A fake model requests 4 writes in a single
// turn against 3 named resources: three of them touch three DIFFERENT
// resources and may run together; the fourth touches the SAME resource as
// the first and must wait for it. The printed timeline shows the
// three-different-key writes overlapping (all in flight together) and the
// conflicting pair running strictly one after another — with every result
// still returned in request order.
// Run with: npx tsx demos/08-scheduling.ts

import { readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  createWorkerSession,
  METRICS_FILENAME,
  runWorkerCycle,
  writeWorkerSessionMetrics,
} from '../src/loop/workerSession.js';
import type { ModelResponse } from '../src/loop/messages.js';
import { finalizeManifest, initManifest } from '../src/run/artifacts.js';
import { createRunBudgetTracker } from '../src/run/runBudget.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { accessKey, createRegistry, type ToolDef } from '../src/tools/registry.js';

const TASK = 'Apply four changes: three to independent resources, one that conflicts with the first.';

/** One recorded execution: when the probe started and finished, in ms
 * relative to the start of the run. */
interface Span {
  label: string;
  resource: string;
  startMs: number;
  endMs: number;
}

const spans: Span[] = [];
const runStartedMs = Date.now();

const probeInput = z.object({ label: z.string(), delayMs: z.number(), resource: z.string() });

/** An instrumented write probe: idles `delayMs` against a named resource,
 * recording its span. Its access is derived from `resource` — the same tool
 * called against different resources has different access, exactly the
 * point `getAccess(input)` exists for. */
const probeWrite: ToolDef<z.infer<typeof probeInput>> = {
  name: 'probe_write',
  description: 'Instrumented write probe: idles delayMs against a named resource and reports back.',
  inputSchema: probeInput,
  getAccess: (input) => ({ reads: [], writes: [accessKey.file(input.resource)] }),
  execute: async ({ label, delayMs, resource }) => {
    const startMs = Date.now() - runStartedMs;
    await new Promise((wake) => setTimeout(wake, delayMs));
    spans.push({ label, resource, startMs, endMs: Date.now() - runStartedMs });
    return `${label} done after ${delayMs}ms`;
  },
};

// The single scripted turn: writes to alpha, beta, gamma (three distinct
// resources — none conflict, so all three may overlap), then a second write
// to alpha (conflicts with the first alpha write, so it must serialize
// after it), one response. Delays are deliberately large enough that serial
// execution would be obvious.
const script: ModelResponse[] = [
  {
    content: [
      { type: 'text', text: 'Applying all four changes.' },
      {
        type: 'tool_use',
        id: 'w1',
        name: 'probe_write',
        input: { label: 'alpha-1', delayMs: 100, resource: 'alpha' },
      },
      {
        type: 'tool_use',
        id: 'w2',
        name: 'probe_write',
        input: { label: 'beta', delayMs: 60, resource: 'beta' },
      },
      {
        type: 'tool_use',
        id: 'w3',
        name: 'probe_write',
        input: { label: 'gamma', delayMs: 80, resource: 'gamma' },
      },
      {
        type: 'tool_use',
        id: 'w4',
        name: 'probe_write',
        input: { label: 'alpha-2', delayMs: 60, resource: 'alpha' },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 900, output_tokens: 120 },
  },
  {
    content: [{ type: 'text', text: 'All four changes applied.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1100, output_tokens: 30, cache_read_input_tokens: 850 },
  },
];

let served = 0;
async function callModel(): Promise<ModelResponse> {
  const response = script[served];
  if (response === undefined) {
    throw new Error('fake model script exhausted — the session should have stopped');
  }
  served += 1;
  return response;
}

/** Render one span as a bar on a shared ms-scaled axis. */
function bar(span: Span, totalMs: number, width: number): string {
  const from = Math.round((span.startMs / totalMs) * width);
  const to = Math.max(from + 1, Math.round((span.endMs / totalMs) * width));
  const lane = ' '.repeat(from) + '█'.repeat(to - from) + ' '.repeat(width - to);
  return `[${span.resource.padEnd(5)}] ${span.label.padEnd(8)} |${lane}| ${String(span.startMs).padStart(4)}–${span.endMs}ms`;
}

const registry = createRegistry([probeWrite]);
const runDir = createRunDir('runs', generateRunId('demo scheduling'));
initManifest(runDir, TASK);
console.log(`run dir: ${runDir}`);
console.log(`task:    ${TASK}\n`);

const budget = createRunBudgetTracker({
  maxWorkerTurns: 3,
  maxToolCalls: Infinity,
  maxModelTokens: Infinity,
  maxToolResultBytes: Infinity,
  maxWallTimeMs: Infinity,
  maxVerifierCorrections: 0,
});
const session = createWorkerSession(TASK, { callModel, registry, runDir }, { budget, maxContextTokens: 100_000 });
const outcome = await runWorkerCycle(session);
writeWorkerSessionMetrics(session, outcome.kind === 'completed' ? 'completed' : 'budget_exceeded');
finalizeManifest(runDir);

console.log(`result: ${JSON.stringify(outcome)}\n`);

// The timeline, in request order: the alpha-1/beta/gamma bars overlap; the
// alpha-2 bar starts only after alpha-1 finishes.
const totalMs = Math.max(...spans.map((span) => span.endMs));
const byRequestOrder = ['alpha-1', 'beta', 'gamma', 'alpha-2'];
console.log(`--- timeline (0–${totalMs}ms) ---`);
for (const label of byRequestOrder) {
  const span = spans.find((candidate) => candidate.label === label);
  if (span === undefined) throw new Error(`probe ${label} never ran`);
  console.log(bar(span, totalMs, 48));
}

const differentKeySpans = spans.filter((span) => span.label !== 'alpha-2');
const alpha1 = spans.find((span) => span.label === 'alpha-1')!;
const alpha2 = spans.find((span) => span.label === 'alpha-2')!;
const differentKeysOverlapped =
  Math.max(...differentKeySpans.map((span) => span.startMs)) <
  Math.min(...differentKeySpans.map((span) => span.endMs));
const conflictingPairSerialized = alpha2.startMs >= alpha1.endMs;
console.log(
  `\ndifferent-key writes overlapped: ${differentKeysOverlapped} (alpha-1, beta, gamma all in flight at once)`,
);
console.log(
  `conflicting pair serialized:     ${conflictingPairSerialized} (alpha-2 starts only after alpha-1 finishes)`,
);
console.log(`\n--- ${METRICS_FILENAME} ---`);
console.log(readFileSync(`${runDir}/${METRICS_FILENAME}`, 'utf8'));
