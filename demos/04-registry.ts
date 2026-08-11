// Demo for T4: register a toy echo tool, then run one call down each path
// of the execution pipeline — valid, unknown tool, malformed input.
// Run with: npx tsx demos/04-registry.ts

import { z } from 'zod';

import { executeToolCall, type ToolCall } from '../src/tools/pipeline.js';
import {
  createRegistry,
  toApiToolDefs,
  type ToolCtx,
  type ToolDef,
} from '../src/tools/registry.js';

const echo: ToolDef<{ message: string }> = {
  name: 'echo',
  description: 'Echo the message back, prefixed with "echo:".',
  inputSchema: z.object({ message: z.string() }),
  readOnly: true,
  execute: async (input) => `echo: ${input.message}`,
};

const registry = createRegistry([echo]);
const ctx: ToolCtx = { runDir: '/tmp/demo-run-dir' }; // no tool touches it here

console.log('--- Claude API tool defs (toApiToolDefs) ---');
console.log(JSON.stringify(toApiToolDefs(registry), null, 2));

const calls: Array<[label: string, call: ToolCall]> = [
  ['valid call', { id: 'demo-1', name: 'echo', input: { message: 'hello, registry' } }],
  ['unknown tool', { id: 'demo-2', name: 'teleport', input: { to: 'the moon' } }],
  ['malformed input', { id: 'demo-3', name: 'echo', input: { message: 42 } }],
];

for (const [label, call] of calls) {
  const result = await executeToolCall(registry, call, ctx);
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(result, null, 2));
}
