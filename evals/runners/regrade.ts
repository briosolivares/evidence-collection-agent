/**
 * Regrade existing run directories through the standard eval grading path:
 * `npx tsx --env-file=.env evals/runners/regrade.ts <task>:<runDir>,<runDir>,...`
 * (one argument per task, run dirs in trial order; every task needs the
 * same number of run dirs, which becomes the report's k).
 *
 * Exists because the eval CLI grades all-or-nothing at the end of a live
 * run: a transient failure (network blip during an oracle fetch, an API
 * overload mid-trial) discards the grading of every trial that already
 * finished. This entry point replays finished run dirs through the same
 * runEvals seam the tests use — a RunTaskFn that returns the next existing
 * run dir instead of running an agent — so oracles are fetched fresh and
 * graders see exactly what a live eval would show them (the standing rule
 * holds: graders read only the run directory plus oracle data).
 *
 * Caveats: trial latencies in the report measure the replay (effectively
 * zero), not the original runs — read wall-clock from each run's
 * metrics.json instead. And Tier A oracles are fetched at *regrade* time,
 * so grade soon after the runs; a moving ground truth drifts away from
 * what the agent saw.
 */
import { resolve } from 'node:path';

import { DATASETS_DIR, EXPERIMENTS_DIR, MODEL } from '../config.js';
import { DEFAULT_TOOL_PROFILE } from '../../src/tools/index.js';
import type { EvalTask, RunTaskFn } from '../types.js';
import { loadEvalTask } from './loadTask.js';
import { formatReport, writeResults } from './report.js';
import { runEvals } from './runner.js';

async function main(): Promise<void> {
  const pairs = process.argv.slice(2).map((arg) => {
    const colon = arg.indexOf(':');
    if (colon === -1) {
      throw new Error(`expected <task>:<runDir>[,<runDir>...], got "${arg}"`);
    }
    return {
      name: arg.slice(0, colon),
      runDirs: arg
        .slice(colon + 1)
        .split(',')
        .filter((dir) => dir !== '')
        .map((dir) => resolve(dir)),
    };
  });
  if (pairs.length === 0) {
    throw new Error('usage: regrade.ts <task>:<runDir>[,<runDir>...] ...');
  }
  const k = pairs[0]!.runDirs.length;
  for (const pair of pairs) {
    if (pair.runDirs.length !== k) {
      throw new Error(
        `every task needs the same number of run dirs (k): ` +
          `"${pairs[0]!.name}" has ${k}, "${pair.name}" has ${pair.runDirs.length}`,
      );
    }
  }

  const tasks: EvalTask[] = [];
  for (const pair of pairs) {
    tasks.push(await loadEvalTask(DATASETS_DIR, pair.name));
  }

  const runDirsByTask = new Map(pairs.map((pair) => [pair.name, pair.runDirs]));
  const replayRunTask: RunTaskFn = async (_taskText, opts) => {
    const runDir = runDirsByTask.get(opts.taskName)?.[opts.trialIndex];
    if (runDir === undefined) {
      throw new Error(
        `missing run dir for task "${opts.taskName}" trial ${opts.trialNumber}`,
      );
    }
    return { runDir };
  };

  const report = await runEvals(tasks, k, {
    runTask: replayRunTask,
    concurrency: 1,
    model: MODEL,
    toolProfile: DEFAULT_TOOL_PROFILE,
  });

  console.log(formatReport(report));
  console.log(`\nresults JSON: ${writeResults(report, EXPERIMENTS_DIR)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
