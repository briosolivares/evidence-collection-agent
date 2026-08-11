// Demo for T9: the first real agent run — the T7 loop unchanged, but with
// deps.callModel now the production streaming Anthropic client (file tools
// only; no browser yet). Run with:
//
//   npx tsx demos/09-real-agent.ts ["task text"]
//
// Requires ANTHROPIC_API_KEY in the environment (the SDK's other ambient
// credential sources also work). This is a demo, not a test: it spends real
// tokens, which is why it lives in demos/ and the automated suite never
// runs it.
//
// What to verify afterwards (the design's explicit prompt-caching check):
// in the printed metrics.json, cacheReadInputTokens must be > 0 for any run
// of 2+ turns — from turn 2 onward each call should re-read the cached
// system-prompt + tool-definitions prefix. If it stays 0, the prefix is
// unstable (something dynamic leaked into system or tools) and that is a
// bug. Caveat: the prefix must exceed the model's minimum cacheable length
// (1024 tokens on claude-sonnet-5) — the system prompt below is deliberately
// substantial partly for that reason.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METRICS_FILENAME, runAgentLoop, type RunMetrics } from '../src/loop/agentLoop.js';
import { makeCallModel, type ProgressEvent } from '../src/model/callModel.js';
import { finalizeManifest, initManifest, MANIFEST_FILENAME } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { fileTools } from '../src/tools/index.js';
import { createRegistry, toApiToolDefs } from '../src/tools/registry.js';

const DEFAULT_TASK = 'Write a limerick about auditors to limerick.txt';

// The demo's system prompt. T14 owns the real production prompt; this one
// is a faithful stand-in for a file-tools-only run — and it doubles as the
// bulk of the stable cached prefix, so it is written out in full rather
// than compressed to a one-liner.
const SYSTEM_PROMPT = `You are an evidence-collection agent working inside a dedicated run \
directory. Your job on each run is to complete the user's task by operating on files with \
the tools provided, and to leave behind a run directory whose contents speak for \
themselves: every file you were asked to produce exists, is complete, and matches what \
you claim about it in your final message.

How to work:

- Do the work with tools. When the task calls for creating, reading, or searching file \
content, call the appropriate tool rather than merely describing what the file would \
contain. Prose alone completes nothing: a file exists only once write_file has written it.
- All paths are relative to the run directory. Never use absolute paths and never try to \
reach outside the run directory; the tools will refuse, and the attempt wastes a turn.
- Write complete files in one write_file call. The tool replaces the whole file, so \
compose the full content first and write it once rather than building a file up in \
fragments across calls.
- Verify before you finish. After producing the files the task asks for, read the \
important ones back with read_file and confirm the content on disk is exactly what you \
intended — a truncated or malformed artifact discovered by the user later is a failed \
run. If verification reveals a problem, fix it and verify again.
- Recover from tool errors. A failed tool call comes back as an error result describing \
what went wrong (bad path, missing file, invalid input). Read it, adjust, and try again; \
do not repeat the identical call and do not give up after a single failure.
- Be economical. Prefer the fewest tool calls that get the task genuinely done: no \
re-reading files you just wrote and already verified, no exploratory listings the task \
does not need, no gratuitous scratch files.

When the task is complete and verified, finish by responding without any tool calls. \
That final message is your report to the user: state plainly what you produced, name \
each file you wrote by its relative path, and give a one-line description of its \
contents. Do not pad the report with process narration; the transcript already records \
how you worked. If the task cannot be completed, say so explicitly, explain what \
blocked you, and name whatever partial artifacts you did produce so the user can judge \
them for themselves.`;

/** Render one live progress event to the terminal as the stream arrives. */
function printProgress(event: ProgressEvent): void {
  switch (event.type) {
    case 'turn_start':
      process.stdout.write(`\n=== turn ${event.turn} ===\n`);
      break;
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'tool_use_start':
      process.stdout.write(`\n[tool call: ${event.toolName}]`);
      break;
    case 'turn_end': {
      const { input_tokens, output_tokens, cache_read_input_tokens } = event.usage;
      process.stdout.write(
        `\n(usage: in=${input_tokens} out=${output_tokens} cache_read=${cache_read_input_tokens ?? 0})\n`,
      );
      break;
    }
  }
}

const task = process.argv[2] ?? DEFAULT_TASK;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    'warning: ANTHROPIC_API_KEY is not set — the SDK will try its other ambient ' +
      'credential sources; without any, the first model call will fail.',
  );
}

const registry = createRegistry(fileTools);
const runDir = createRunDir('runs', generateRunId('demo real-agent'));
initManifest(runDir, task);
console.log(`run dir: ${runDir}`);
console.log(`task:    ${task}`);

const callModel = makeCallModel({
  system: SYSTEM_PROMPT,
  apiToolDefs: toApiToolDefs(registry),
  maxOutputTokens: 8192,
  onProgress: printProgress,
});

const result = await runAgentLoop(task, { callModel, registry, runDir }, {
  maxTurns: 12,
  maxTokens: 250_000,
});
finalizeManifest(runDir);

console.log(`\nfinal status: ${JSON.stringify(result)}`);
console.log(`run dir:      ${runDir}`);

console.log('\n--- manifest.json ---');
console.log(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'));

console.log('--- metrics.json ---');
const metricsRaw = readFileSync(join(runDir, METRICS_FILENAME), 'utf8');
console.log(metricsRaw);

// The design's explicit verification: a stable prefix means cache reads
// from turn 2 onward. One turn never reads (the first call writes the
// cache), so the check only applies to multi-turn runs.
const metrics = JSON.parse(metricsRaw) as RunMetrics;
if (metrics.turns >= 2) {
  console.log(
    metrics.cacheReadInputTokens > 0
      ? `prompt-cache check: PASS (cacheReadInputTokens=${metrics.cacheReadInputTokens})`
      : 'prompt-cache check: FAIL — cacheReadInputTokens is 0 over 2+ turns; the prefix is unstable',
  );
} else {
  console.log('prompt-cache check: skipped (single-turn run — nothing to re-read)');
}
