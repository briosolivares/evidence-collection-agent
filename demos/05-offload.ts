// Demo for T5: a toy tool emits ~1 MB through the execution pipeline. The
// model sees only a short preview + file path; the complete output lands on
// disk inside the run directory, hashed into the manifest.
// Run with: npx tsx demos/05-offload.ts

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { finalizeManifest, initManifest, MANIFEST_FILENAME, type Manifest } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { type OffloadedResult } from '../src/tools/capResult.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry, type ToolDef } from '../src/tools/registry.js';

// A stand-in for any chatty tool (a huge page outline, a giant file read):
// ~1 MB of line-numbered output.
const dumpLog: ToolDef<{ lines: number }> = {
  name: 'dump_log',
  description: 'Emit a large synthetic log, one numbered line at a time.',
  inputSchema: z.object({ lines: z.number() }),
  readOnly: true,
  execute: async (input) =>
    Array.from(
      { length: input.lines },
      (_, i) => `[line ${String(i + 1).padStart(6, '0')}] all systems nominal`,
    ).join('\n'),
};

const registry = createRegistry([dumpLog]);
const runDir = createRunDir('runs', generateRunId('demo offload'));
initManifest(runDir, 'demo: offload an oversize tool result');
console.log(`created run dir: ${runDir}`);

// 30,000 lines × 34 bytes ≈ 1 MB — 20× over the 50 KB default cap.
const result = await executeToolCall(
  registry,
  { id: 'demo-1', name: 'dump_log', input: { lines: 30_000 } },
  { runDir },
);
finalizeManifest(runDir);

if (result.isError) throw new Error(`unexpected tool error: ${result.content}`);
const replacement = JSON.parse(result.content) as OffloadedResult;

console.log('\n--- what the model sees (the capped tool result) ---');
console.log(`note:    ${replacement.note}`);
console.log(`preview: (${Buffer.byteLength(replacement.preview, 'utf8')} bytes)`);
console.log(replacement.preview.split('\n').slice(0, 5).join('\n'));
console.log(`... (${replacement.preview.split('\n').length - 5} more preview lines)`);

console.log('\n--- what landed on disk ---');
const offloadPath = join(runDir, replacement.offloadedTo);
const { size } = statSync(offloadPath);
console.log(`${replacement.offloadedTo}: ${size.toLocaleString()} bytes on disk`);

const manifest = JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
const entry = manifest.artifacts.find((a) => a.filename === replacement.offloadedTo);
console.log('manifest entry:');
console.log(JSON.stringify(entry, null, 2));
