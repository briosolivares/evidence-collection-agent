// Demo for T14: run the complete evidence-collection agent against a live
// website with a visible, persistent Chrome profile, via the configured
// browser provider (local Chrome by default). Run with:
//
//   npx tsx demos/12-run-task.ts "Create a CSV of the top 5 Hacker News stories with title, URL, and points"
//
// Requires ANTHROPIC_API_KEY (or another SDK-supported credential source).
// This spends real tokens and accesses a live site, so it is intentionally
// a demo rather than part of the hermetic automated suite.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createBrowserSessionProvider, describeBrowserProvider } from '../src/browser/provider.js';
import { runTask } from '../src/cli/runTask.js';
import { METRICS_FILENAME, type RunMetrics } from '../src/loop/workerSession.js';
import type { ProgressEvent } from '../src/model/callModel.js';

const DEFAULT_TASK =
  'Create a CSV of the top 5 Hacker News stories with title, URL, and points';
const START_URL = 'https://news.ycombinator.com/';
const PROFILE_DIR = resolve('chrome-profile');

const task = process.argv.slice(2).join(' ').trim() || DEFAULT_TASK;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    'warning: ANTHROPIC_API_KEY is not set — the SDK will try its other ambient ' +
      'credential sources; without any, the first model call will fail.',
  );
}

console.log(`task:        ${task}`);
console.log(`start URL:   ${START_URL}`);
console.log(describeBrowserProvider({ profileDir: PROFILE_DIR }));

const browserSessionProvider = createBrowserSessionProvider({
  profileDir: PROFILE_DIR,
});
const browser = await browserSessionProvider.createSession();

try {
  const result = await runTask(task, {
    browser,
    startUrl: START_URL,
    onProgress: printProgress,
  });

  console.log(`\nfinal result: ${JSON.stringify(result)}`);
  console.log(`run dir:      ${result.runDir}`);

  const metricsRaw = readFileSync(join(result.runDir, METRICS_FILENAME), 'utf8');
  console.log('\n--- metrics.json ---');
  console.log(metricsRaw);

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
} finally {
  await browser.close();
}

/** Render one live model-stream progress event at the terminal edge. */
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
