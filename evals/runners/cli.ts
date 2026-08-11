/**
 * Eval CLI entry point: `npm run evals -- --tasks <a,b,c> [--k <n>]`.
 * Loads the named tasks, runs k trials each, prints the report, and writes
 * it to a results JSON under evals/experiments/.
 *
 * This file is the harness's composition root and only printing edge; all
 * logic lives in the modules it wires together. Paths and defaults come
 * from evals/config.ts.
 */
import { launchPersistentChrome } from '../../src/browser/playwrightAdapter.js';
import { formatProgressEvent } from '../../src/cli/replFormat.js';
import { runTask } from '../../src/cli/runTask.js';
import { DATASETS_DIR, EXPERIMENTS_DIR, MODEL, PROFILE_DIR, RUNS_DIR } from '../config.js';
import { parseEvalArgs } from './cliArgs.js';
import { loadEvalTask } from './loadTask.js';
import { formatReport, writeResults } from './report.js';
import { runEvals } from './runner.js';
import type { EvalTask, RunTaskFn } from '../types.js';

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));

  const tasks: EvalTask[] = [];
  for (const name of args.tasks) {
    tasks.push(await loadEvalTask(DATASETS_DIR, name));
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
        model: MODEL,
        runsBaseDir: RUNS_DIR,
        startUrl: opts.startUrl,
        onProgress: (event) => process.stdout.write(formatProgressEvent(event)),
      });

    const report = await runEvals(tasks, args.k, { runTask: realRunTask, model: MODEL });

    console.log(formatReport(report));
    console.log(`\nresults JSON: ${writeResults(report, EXPERIMENTS_DIR)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
