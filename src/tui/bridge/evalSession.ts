// Sherlock's /evals bridge: dataset discovery, shared concurrent scheduling,
// keyed progress projection, cancellation, and standard report persistence.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadEvalTask } from '../../../evals/runners/loadTask.js';
import { formatReport, writeResults } from '../../../evals/runners/report.js';
import { EvalRunCancelledError, runEvals, type EvalReport } from '../../../evals/runners/runner.js';
import type { EvalRunOptions, EvalTask } from '../../../evals/types.js';
import { usableStartUrl } from '../../agent/runTask.js';
import { DEFAULT_MODEL } from '../../model/callModel.js';
import type { StoreAction } from '../store/reducer.js';
import type { UiEvent } from '../store/state.js';
import type { EvalBatchHandle, EvalTaskChoice } from './evalsFeature.js';
import type { RunHandle, RunSessionDeps } from './runSession.js';

/** Starts one eval trial with its selected browser policy. The optional
 * dialog resolver rides along for headed trials only — the eval runtime
 * forwards it exclusively on the headed lane (see evalRuntime.ts). */
export type EvalRunner = (
  task: string,
  onEvent: (event: UiEvent) => void,
  opts: EvalRunOptions & { requestPermission?: RunSessionDeps['requestPermission'] },
) => RunHandle;

export interface EvalSessionDeps {
  onAction: (action: StoreAction) => void;
  evalsDir: string;
  resultsDir: string;
  runner: EvalRunner;
  /** The App's question-dialog resolver. Present in the real TUI: headed
   * trials get live dialogs — the user can answer questions and act in the
   * visible browser mid-trial (e.g. complete a login). Absent, every trial
   * runs unassisted. Answered (allowed) dialogs are counted and stamped on
   * the report as `assistedDialogs`, so assisted scores are always labeled. */
  requestPermission?: RunSessionDeps['requestPermission'];
  loadTask?: (evalsDir: string, name: string) => Promise<EvalTask>;
  formatReportFn?: (report: EvalReport) => string;
  writeResultsFn?: (report: EvalReport, resultsDir: string) => string;
}

export { usableStartUrl };

/** Discover task packages and their browser-lane marker, alphabetically. */
export function discoverEvalTasks(evalsDir: string): EvalTaskChoice[] {
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
    .sort()
    .map((name) => ({ name, headed: readHeaded(join(evalsDir, name, 'task.json')) }));
}

/** Run one cancellable concurrent eval batch through the shared harness. */
export function startEvalBatch(
  taskNames: readonly string[],
  k: number,
  concurrency: number,
  deps: EvalSessionDeps,
): EvalBatchHandle {
  const emit = deps.onAction;
  const loadTask = deps.loadTask ?? loadEvalTask;
  const formatReportFn = deps.formatReportFn ?? formatReport;
  const writeResultsFn = deps.writeResultsFn ?? writeResults;
  const controller = new AbortController();
  let cancelled = false;

  // Count answered dialogs so the report can be labeled: an allow decision
  // means information flowed from the human into a trial, and that trial's
  // score is no longer comparable to unassisted batches. Denied/dismissed
  // dialogs assist nothing and are not counted.
  let assistedDialogs = 0;
  const askUser = deps.requestPermission;
  const countingRequestPermission =
    askUser === undefined
      ? undefined
      : (request: Parameters<NonNullable<RunSessionDeps['requestPermission']>>[0]) =>
          askUser(request).then((decision) => {
            if (decision.behavior === 'allow') assistedDialogs += 1;
            return decision;
          });

  emit({ type: 'evals_started', tasks: [...taskNames], k, concurrency });

  const done: Promise<'completed' | 'cancelled' | 'failed'> = (async () => {
    try {
      const tasks = await Promise.all(taskNames.map((name) => loadTask(deps.evalsDir, name)));
      const report = await runEvals(tasks, k, {
        concurrency,
        model: DEFAULT_MODEL,
        signal: controller.signal,
        runTask: async (taskText, opts) => {
          if (controller.signal.aborted) throw new EvalRunCancelledError();
          const startUrl = usableStartUrl(opts.startUrl);
          const handle = deps.runner(
            taskText,
            (event) => {
              const status = evalProgressStatus(event);
              if (status !== undefined) {
                emit({
                  type: 'eval_trial_progress',
                  task: opts.taskName,
                  trial: opts.trialNumber,
                  status,
                });
              }
            },
            {
              ...opts,
              ...(startUrl === undefined ? { startUrl: undefined } : { startUrl }),
              ...(countingRequestPermission === undefined
                ? {}
                : { requestPermission: countingRequestPermission }),
            },
          );
          const abort = () => handle.cancel();
          opts.signal.addEventListener('abort', abort, { once: true });
          if (opts.signal.aborted) handle.cancel();

          try {
            const outcome = await handle.done;
            if (outcome.status === 'cancelled') throw new EvalRunCancelledError();
            if (outcome.status === 'failed') {
              throw new Error(`trial run failed: ${outcome.message}`);
            }
            return { runDir: outcome.runDir };
          } finally {
            opts.signal.removeEventListener('abort', abort);
          }
        },
        onTrialStarted: (job) => {
          emit({
            type: 'eval_trial_started',
            task: job.taskName,
            trial: job.trialNumber,
            k: job.k,
            headed: job.headed,
          });
        },
        onTrialRunFinished: (job) => {
          emit({
            type: 'eval_trial_progress',
            task: job.taskName,
            trial: job.trialNumber,
            status: 'grading',
          });
        },
        onTrialGraded: (job, grade) => {
          emit({
            type: 'eval_trial_done',
            task: job.taskName,
            trial: job.trialNumber,
            k: job.k,
            assertions: grade.assertions,
            elapsedMs: grade.latencyMs,
          });
        },
      });

      const finalReport: EvalReport = assistedDialogs > 0 ? { ...report, assistedDialogs } : report;
      const resultsPath = writeResultsFn(finalReport, deps.resultsDir);
      emit({
        type: 'eval_report_ready',
        text: `${formatReportFn(finalReport)}\n\nresults JSON: ${resultsPath}`,
      });
      emit({ type: 'evals_finished' });
      return 'completed';
    } catch (error) {
      if (cancelled || error instanceof EvalRunCancelledError) {
        emit({
          type: 'notice',
          text: 'Evals interrupted — active trials cancelled and queued trials skipped.',
        });
        emit({ type: 'evals_finished' });
        return 'cancelled';
      }
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
      if (cancelled) return;
      cancelled = true;
      controller.abort();
    },
    done,
  };
}

function readHeaded(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { headed?: unknown };
    return parsed.headed === true;
  } catch {
    return false;
  }
}

function evalProgressStatus(event: UiEvent): string | undefined {
  switch (event.type) {
    case 'turn_start':
      return `turn ${event.turn}`;
    case 'tool_pending':
      return `preparing ${event.name}`;
    case 'tool_exec_start':
      return `running ${event.name}`;
    case 'tool_exec_end':
      return event.ok ? 'tool complete' : 'tool failed';
    default:
      return undefined;
  }
}
