// Demo for T6: the three Claude Code–shaped file tools — write_file,
// read_file, grep — executed against a real run directory through the full
// pipeline (validation → execute → cap), end to end, no model yet. Every
// write lands in the manifest; every path is confined to the run dir.
// Run with: npx tsx demos/06-file-tools.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { finalizeManifest, initManifest, MANIFEST_FILENAME } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { editFileTool, grepTool, readFileTool, writeFileTool } from '../src/tools/index.js';
import { executeToolCall, type ToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';

const registry = createRegistry([readFileTool, writeFileTool, editFileTool, grepTool]);
const runDir = createRunDir('runs', generateRunId('demo file-tools'));
initManifest(runDir, 'demo: file tools through the pipeline');
console.log(`created run dir: ${runDir}`);

let callCount = 0;
async function demoCall(name: string, input: ToolCall['input']): Promise<void> {
  callCount += 1;
  console.log(`\n--- ${name} ${JSON.stringify(input)} ---`);
  const result = await executeToolCall(registry, { id: `demo-${callCount}`, name, input }, { runDir });
  console.log(result.isError ? `[error] ${result.content}` : result.content);
}

// 1. write_file: a deliverable lands in the run dir — and in the manifest.
await demoCall('write_file', {
  file_path: 'scratch/notes/observations.md',
  content: [
    '# Observations',
    '',
    '- The pricing page lists three tiers.',
    '- The enterprise tier hides its price behind a contact form.',
    '- Screenshot captured before the popup appeared.',
  ].join('\n'),
});

// 2. read_file: line-numbered content back, whole file then a window.
await demoCall('read_file', { file_path: 'scratch/notes/observations.md' });
await demoCall('read_file', { file_path: 'scratch/notes/observations.md', offset: 3, limit: 2 });

// 3. grep: pattern search across the run dir, results as path:line: match.
await demoCall('grep', { pattern: 'tier' });
await demoCall('grep', { pattern: 'price|Screenshot', path: 'scratch/notes' });

// 4. Confinement: an escaping path comes back as a structured error the
// model can read — nothing outside the run dir is ever touched.
await demoCall('read_file', { file_path: '../../../etc/passwd' });

finalizeManifest(runDir);
console.log('\n--- manifest ---');
console.log(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'));
