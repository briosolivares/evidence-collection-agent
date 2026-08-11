// The /evals bridge: task discovery over the filesystem convention
// (evals/<name>/task.json — no core discovery API exists) and a
// sequential trial loop over the harness's exported parts. runEvals()
// itself is deliberately not used — it is fire-and-wait with no per-trial
// progress; this loop drives loadEvalTask → bridge run → fetchOracle →
// grade → summarizeTask, streaming every trial through the same live-run
// pipeline as interactive tasks, then formats/persists the report exactly
// as the CLI does.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadEvalTask } from '../../../evals/loadTask.js';
import { summarizeTask, type TaskReport, type TrialGrade } from '../../../evals/metrics.js';
import { formatReport, writeResults } from '../../../evals/report.js';
import type { EvalReport } from '../../../evals/runner.js';
import type { EvalTask } from '../../../evals/types.js';
import type { StoreAction } from '../store/reducer.js';
import type { UiEvent } from '../store/state.js';
import type { RunHandle } from './runSession.js';

/** Starts one bridged run for a trial (the runtime's startRun). */
export type EvalRunner = (
  task: string,
  onEvent: (event: UiEvent) => void,
  opts?: { startUrl?: string },
) => RunHandle;

/** Dependencies for one eval batch; optional members are test seams. */
export interface EvalSessionDeps {
  /** Receives the batch's store actions (trial framing + run events). */
  onAction: (action: StoreAction) => void;
  /** Directory holding eval task definitions. */
  evalsDir: string;
  /** Where the results JSON is written (the CLI's convention). */
  resultsDir: string;
  /** Runs one trial through the live-run pipeline. */
  runner: EvalRunner;
  loadTask?: (evalsDir: string, name: string) => Promise<EvalTask>;
  formatReportFn?: (report: EvalReport) => string;
  writeResultsFn?: (report: EvalReport, resultsDir: string) => string;
  now?: () => number;
}

/** A live eval batch: cancel skips the rest; done resolves, never rejects. */
export interface EvalBatchHandle {
  cancel(): void;
  done: Promise<'completed' | 'cancelled' | 'failed'>;
}

/** Keep only start URLs runTask's contract accepts (HTTP/HTTPS pages).
 * A fresh task tab is already about:blank, so non-HTTP start URLs (the
 * stub task uses "about:blank" for fake-agent harness tests) are simply
 * dropped rather than crashing the trial. */
export function usableStartUrl(startUrl: string | undefined): string | undefined {
  if (startUrl === undefined) return undefined;
  try {
    const protocol = new URL(startUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' ? startUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover eval task names: directories under evalsDir containing a
 * task.json, alphabetically.
 */
export function discoverEvalTasks(evalsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(evalsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const dir = join(evalsDir, name);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'task.json'));
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Run k trials of each named task sequentially, streaming progress.
 *
 * Ordering per trial: eval_trial_started → the run's own UiEvents (the
 * live pipeline) → eval_trial_done with assertion verdicts. After all
 * tasks: eval_report_ready (formatReport text + results path) then
 * evals_finished. Esc-cancellation of the current trial's run skips every
 * remaining trial; no partial report is written. The grader is handed
 * exactly the trial's run directory and its freshly fetched oracle data.
 */
export function startEvalBatch(
  taskNames: readonly string[],
  k: number,
  deps: EvalSessionDeps,
): EvalBatchHandle {
  const emit = deps.onAction;
  const loadTask = deps.loadTask ?? loadEvalTask;
  const formatReportFn = deps.formatReportFn ?? formatReport;
  const writeResultsFn = deps.writeResultsFn ?? writeResults;
  const now = deps.now ?? Date.now;

  let cancelled = false;
  let currentRun: RunHandle | undefined;

  emit({ type: 'evals_started', tasks: [...taskNames], k });

  const done: Promise<'completed' | 'cancelled' | 'failed'> = (async () => {
    try {
      const startedAt = new Date(now()).toISOString();
      const taskReports: TaskReport[] = [];

      for (const name of taskNames) {
        if (cancelled) break;
        const task = await loadTask(deps.evalsDir, name);
        const trials: TrialGrade[] = [];

        for (let trial = 1; trial <= k && !cancelled; trial++) {
          emit({ type: 'eval_trial_started', task: name, trial, k });
          const trialStart = now();
          const startUrl = usableStartUrl(task.startUrl);
          currentRun = deps.runner(task.taskText, emit, {
            ...(startUrl === undefined ? {} : { startUrl }),
          });
          const outcome = await currentRun.done;
          currentRun = undefined;
          const latencyMs = now() - trialStart;

          if (outcome.status === 'cancelled') {
            cancelled = true;
            break;
          }
          if (outcome.status === 'failed') {
            throw new Error(`trial run failed: ${outcome.message}`);
          }

          // Ground truth is fetched at grading time, per trial; the grader
          // sees only the run directory and that oracle data.
          const oracleData = await task.fetchOracle();
          const assertions = await task.grade(outcome.runDir, oracleData);
          trials.push({ runDir: outcome.runDir, assertions, latencyMs });
          emit({
            type: 'eval_trial_done',
            task: name,
            trial,
            k,
            assertions,
            elapsedMs: latencyMs,
          });
        }

        if (cancelled) break;
        taskReports.push(summarizeTask(name, trials));
      }

      if (cancelled) {
        emit({ type: 'notice', text: 'Evals interrupted — remaining trials skipped.' });
        emit({ type: 'evals_finished' });
        return 'cancelled';
      }

      const report: EvalReport = {
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        k,
        tasks: taskReports,
      };
      const resultsPath = writeResultsFn(report, deps.resultsDir);
      emit({
        type: 'eval_report_ready',
        text: `${formatReportFn(report)}\n\nresults JSON: ${resultsPath}`,
      });
      emit({ type: 'evals_finished' });
      return 'completed';
    } catch (error) {
      emit({
        type: 'eval_error',
        message: `Evals stopped: ${error instanceof Error ? error.message : String(error)}`,
      });
      emit({ type: 'evals_finished' });
      return 'failed';
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      currentRun?.cancel();
    },
    done,
  };
}
