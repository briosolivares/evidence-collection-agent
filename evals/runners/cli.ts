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

import { chromeExecutablePath } from '../../src/config/paths.js';
import { generateRunId } from '../../src/run/runId.js';
import { DATASETS_DIR, EXPERIMENTS_DIR, MODEL, PROFILE_DIR, RUNS_DIR } from '../config.js';
import { parseEvalArgs } from './cliArgs.js';
import { createEvalBrowserRuntime } from './browserRuntime.js';
import { createBrowserBackedRunTask } from './cliRuntime.js';
import { loadEvalTask } from './loadTask.js';
import { formatReport, writeResults } from './report.js';
import { runEvals } from './runner.js';
import { formatEvalProgress, trialLabel } from './progress.js';
import type { EvalTask } from '../types.js';

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

  console.log(
    `eval browsers: default=headless isolated (concurrency ${args.concurrency}); ` +
      'headed tasks=headed persistent logged-in (serial)',
  );
  const browserRuntime = createEvalBrowserRuntime({
    authenticatedProfileDir: PROFILE_DIR,
    executablePath: chromeExecutablePath(),
  });
  try {
    const realRunTask = createBrowserBackedRunTask({
      browserRuntime,
      model: MODEL,
      toolProfile: args.toolProfile,
      runsBaseDir: RUNS_DIR,
      onProgress: (taskName, trialNumber, k, event) => {
        const text = formatEvalProgress(taskName, trialNumber, k, event);
        if (text !== undefined) process.stdout.write(text);
      },
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
      concurrency: args.concurrency,
      model: MODEL,
      toolProfile: args.toolProfile,
      onTrialStarted: (job) => {
        const policy = job.headed ? 'headed persistent' : 'headless isolated';
        console.log(`${trialLabel(job.taskName, job.trialNumber, job.k)} started — ${policy}`);
      },
      onTrialRunFinished: (job, runDir) => {
        console.log(`${trialLabel(job.taskName, job.trialNumber, job.k)} run finished — ${runDir}`);
      },
      onTrialGraded: (job, grade) => {
        try {
          appendFileSync(
            partialPath,
            `${JSON.stringify({
              task: job.taskName,
              trial: job.trialNumber,
              trialIndex: job.trialIndex,
              ...grade,
            })}\n`,
          );
        } catch (err: unknown) {
          console.warn(`warning: could not persist partial grade: ${err instanceof Error ? err.message : err}`);
        }
        if (grade.error !== undefined) {
          console.log(
            `${trialLabel(job.taskName, job.trialNumber, job.k)} errored — ${grade.error}`,
          );
          return;
        }
        const passed = grade.assertions.filter((assertion) => assertion.passed).length;
        console.log(
          `${trialLabel(job.taskName, job.trialNumber, job.k)} graded — ` +
            `${passed}/${grade.assertions.length} assertions`,
        );
      },
    });

    console.log(formatReport(report));
    console.log(`\nresults JSON: ${writeResults(report, EXPERIMENTS_DIR)}`);
    rmSync(partialPath, { force: true });
  } finally {
    await browserRuntime.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
