/**
 * Eval CLI entry point: `npm run evals -- --tasks <a,b,c> [--k <n>]`.
 * Loads the named tasks, runs k trials each, prints the report, and writes
 * it to a results JSON under runs/eval-results/.
 *
 * This file is the harness's composition root and only printing edge; all
 * logic lives in the modules it wires together.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchPersistentChrome } from '../src/browser/playwrightAdapter.js';
import { formatProgressEvent } from '../src/cli/replFormat.js';
import { runTask } from '../src/cli/runTask.js';
import { parseEvalArgs } from './cliArgs.js';
import { loadEvalTask } from './loadTask.js';
import { formatReport, writeResults } from './report.js';
import { runEvals } from './runner.js';
import type { EvalTask, RunTaskFn } from './types.js';

/** Directory holding the eval task definitions — the one this file lives in. */
const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Where trial run dirs are created (gitignored, same home as real runs). */
const RUNS_DIR = 'runs';

/** Where results JSON files land (inside the gitignored runs/). */
const RESULTS_DIR = join(RUNS_DIR, 'eval-results');

/** Persistent Chrome profile shared with the REPL and demos. */
const PROFILE_DIR = resolve('chrome-profile');

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));

  const tasks: EvalTask[] = [];
  for (const name of args.tasks) {
    tasks.push(await loadEvalTask(EVALS_DIR, name));
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      'warning: ANTHROPIC_API_KEY is not set — the SDK will try its other ambient ' +
        'credential sources; without any, the first model call will fail.',
    );
  }

  // The agent under evaluation: the real T14 runTask over one session-long
  // headed browser; each trial gets its own fresh tab (runTask owns tab
  // lifecycle). Tests and the fake agent keep injecting their own RunTaskFn
  // through runEvals — this wiring is the CLI's alone.
  const browser = await launchPersistentChrome({ profileDir: PROFILE_DIR });
  try {
    const realRunTask: RunTaskFn = (taskText, opts) =>
      runTask(taskText, {
        browser,
        runsBaseDir: RUNS_DIR,
        startUrl: opts.startUrl,
        onProgress: (event) => process.stdout.write(formatProgressEvent(event)),
      });

    const report = await runEvals(tasks, args.k, { runTask: realRunTask });

    console.log(formatReport(report));
    console.log(`\nresults JSON: ${writeResults(report, RESULTS_DIR)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
