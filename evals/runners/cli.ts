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

import {
  describeBrowserProvider,
  resolveBrowserProviderKind,
} from '../../src/browser/provider.js';
import { checkProfileLogins } from '../../src/cli/loginCheck.js';
import { allLoggedIn, formatLoginState, loginServicesForIds } from '../../src/cli/loginProbe.js';
import { chromeExecutablePath } from '../../src/config/paths.js';
import { generateRunId } from '../../src/run/runId.js';
import { DATASETS_DIR, EXPERIMENTS_DIR, MODEL, PROFILE_DIR, RUNS_DIR } from '../config.js';
import { parseEvalArgs } from './cliArgs.js';
import { createEvalBrowserRuntime } from './browserRuntime.js';
import { createBrowserBackedRunTask } from './cliRuntime.js';
import { loadEvalTask } from './loadTask.js';
import { formatLoginPreflightFailure, requiredLogins } from './loginPreflight.js';
import { formatReport, writeResults } from './report.js';
import { runEvals, type EvalProtocol } from './runner.js';
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

  // Which browser runtime this batch will use, resolved once and reported
  // before anything launches — a batch whose runtime you have to infer from
  // its failures is a batch you will misread.
  const browserProvider = resolveBrowserProviderKind();

  // Before any tokens are spent: does the authenticated lane hold the sessions
  // this batch's tasks cannot run without? See loginPreflight.ts. The probe
  // goes through the same provider selection the trials will use, so it checks
  // the local profile or the exact Browserbase Context the authenticated lane
  // is about to open — never a different one.
  const requirements = requiredLogins(tasks);
  if (requirements.length > 0 && !args.skipLoginCheck) {
    console.log(
      `login preflight: ${requirements.map((req) => req.id).join(', ')} ` +
        `(${describeBrowserProvider({ profileDir: PROFILE_DIR })})`,
    );
    const statuses = await checkProfileLogins({
      profileDir: PROFILE_DIR,
      executablePath: chromeExecutablePath(),
      services: loginServicesForIds(requirements.map((req) => req.id)),
      headless: true,
      onStatus: (status) => {
        console.log(`  ${status.service.name}: ${formatLoginState(status.state)}`);
      },
    });
    if (!allLoggedIn(statuses)) {
      console.error(formatLoginPreflightFailure(statuses, requirements, browserProvider));
      process.exitCode = 1;
      return;
    }
  } else if (requirements.length > 0) {
    console.log(
      `login preflight: SKIPPED (--skip-login-check); ` +
        `${requirements.map((req) => `${req.id} → ${req.tasks.join('/')}`).join(', ')} unverified`,
    );
  }

  console.log(
    browserProvider === 'browserbase'
      ? `eval browsers: default=Browserbase isolated session per trial ` +
          `(concurrency ${args.concurrency}); headed tasks=one Browserbase session on the ` +
          'configured context (serial)'
      : `eval browsers: default=headless isolated (concurrency ${args.concurrency}); ` +
          'headed tasks=headed persistent logged-in (serial)',
  );
  // Announced before the first trial, not just recorded in the results file:
  // the protocol decides what the batch even measures, and a run whose path
  // you have to reconstruct afterwards is a run you will misread.
  console.log(`eval protocol: typed output contract, authored by the ${args.contractAuthor}`);
  const protocol: EvalProtocol = { completion: 'output-contract', contractAuthor: args.contractAuthor };
  const browserRuntime = createEvalBrowserRuntime({
    authenticatedProfileDir: PROFILE_DIR,
    executablePath: chromeExecutablePath(),
  });
  try {
    const realRunTask = createBrowserBackedRunTask({
      browserRuntime,
      model: MODEL,
      runsBaseDir: RUNS_DIR,
      // Every batch runs the typed output-contract protocol; the only harness
      // choice left is who authors the contract.
      harness: { contractAuthor: args.contractAuthor },
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
      protocol,
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
