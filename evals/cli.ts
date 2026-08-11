/**
 * Eval CLI entry point: `npm run evals -- --tasks <a,b,c> [--k <n>]`.
 * Loads the named tasks, runs k trials each, prints the report, and writes
 * it to a results JSON under runs/eval-results/.
 *
 * This file is the harness's composition root and only printing edge; all
 * logic lives in the modules it wires together.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEvalArgs } from './cliArgs.js';
import { makeFakeRunTask } from './fakeAgent.js';
import { loadEvalTask } from './loadTask.js';
import { formatReport, writeResults } from './report.js';
import { runEvals } from './runner.js';
import type { EvalTask } from './types.js';

/** Directory holding the eval task definitions — the one this file lives in. */
const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Where trial run dirs are created (gitignored, same home as real runs). */
const RUNS_DIR = 'runs';

/** Where results JSON files land (inside the gitignored runs/). */
const RESULTS_DIR = join(RUNS_DIR, 'eval-results');

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));

  const tasks: EvalTask[] = [];
  for (const name of args.tasks) {
    tasks.push(await loadEvalTask(EVALS_DIR, name));
  }

  // The agent under evaluation. T17 ships with the fake agent only; when
  // T14 lands, its real runTask drops in here (it satisfies RunTaskFn
  // structurally) — this line is the single wiring point.
  const runTask = makeFakeRunTask(RUNS_DIR);

  const report = await runEvals(tasks, args.k, { runTask });

  console.log(formatReport(report));
  console.log(`\nresults JSON: ${writeResults(report, RESULTS_DIR)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
