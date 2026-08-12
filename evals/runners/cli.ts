/**
 * Eval CLI entry point: `npm run evals -- --tasks <a,b,c> [--k <n>]`.
 * Loads the named tasks, runs k trials each, prints the report, and writes
 * it to a results JSON under evals/experiments/.
 *
 * This file is the harness's composition root and only printing edge; all
 * logic lives in the modules it wires together. Paths and defaults come
 * from evals/config.ts.
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import { formatProgressEvent } from '../../src/cli/replFormat.js';
import { runTask } from '../../src/cli/runTask.js';
import { generateRunId } from '../../src/run/runId.js';
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
  const browserSessionProvider = new LocalChromeBrowserSessionProvider({
    profileDir: PROFILE_DIR,
  });
  const browser = await browserSessionProvider.createSession();
  try {
    const realRunTask: RunTaskFn = (taskText, opts) =>
      runTask(taskText, {
        browser,
        model: MODEL,
        toolProfile: args.toolProfile,
        runsBaseDir: RUNS_DIR,
        startUrl: opts.startUrl,
        onProgress: (event) => process.stdout.write(formatProgressEvent(event)),
      });

    // Crash insurance: every graded trial is appended to a partial JSONL
    // the moment its grade exists, so a transient failure on a later trial
    // no longer discards finished trials' grades (regrade.ts remains the
    // recovery path for re-grading; this preserves the grades themselves).
    // Removed once the final results JSON lands. Best-effort by design —
    // a persistence hiccup must never abort a live eval.
    mkdirSync(resolve(EXPERIMENTS_DIR), { recursive: true });
    const partialPath = join(resolve(EXPERIMENTS_DIR), `${generateRunId('eval partial')}.jsonl`);
    const report = await runEvals(tasks, args.k, {
      runTask: realRunTask,
      model: MODEL,
      toolProfile: args.toolProfile,
      onTrialGraded: (taskName, trialIndex, grade) => {
        try {
          appendFileSync(partialPath, `${JSON.stringify({ task: taskName, trial: trialIndex, ...grade })}\n`);
        } catch (err: unknown) {
          console.warn(`warning: could not persist partial grade: ${err instanceof Error ? err.message : err}`);
        }
      },
    });

    console.log(formatReport(report));
    console.log(`\nresults JSON: ${writeResults(report, EXPERIMENTS_DIR)}`);
    rmSync(partialPath, { force: true });
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
