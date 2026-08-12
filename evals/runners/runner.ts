import { summarizeTask, type TaskReport, type TrialGrade } from '../metrics/metrics.js';
import type { ToolProfile } from '../../src/tools/index.js';
import type { EvalTask, RunTaskFn } from '../types.js';

/** What the runner needs injected: the agent under evaluation. */
export interface EvalRunnerDeps {
  /** Runs one full trial; the real T14 runTask or a fake. */
  runTask: RunTaskFn;
  /** Name of the model the injected agent runs with, recorded verbatim in
   * the report so past experiments stay comparable across model changes. */
  model: string;
  /** Deterministic tool surface every trial ran with. */
  toolProfile: ToolProfile;
  /** Optional hook awaited after each trial is graded, with the grade just
   * recorded. Exists so callers can persist grades incrementally — without
   * it, grades live only in this process's memory until the report returns,
   * and a crash on a later trial discards every finished trial's grading
   * (the failure regrade.ts recovers from). Callers own their error
   * handling; a rejection here propagates and aborts the eval. */
  onTrialGraded?: (taskName: string, trialIndex: number, grade: TrialGrade) => void | Promise<void>;
}

/** The full result of one eval invocation, over all tasks and trials. */
export interface EvalReport {
  /** ISO 8601 timestamp of when the eval run started. */
  startedAt: string;
  /** ISO 8601 timestamp of when the eval run finished. */
  finishedAt: string;
  /** Trials per task this report was run with. */
  k: number;
  /** Name of the model every trial ran with. */
  model: string;
  /** Tool condition every trial used. */
  toolProfile: ToolProfile;
  /** One aggregated report per task, in the order the tasks were given. */
  tasks: TaskReport[];
}

/**
 * Run every given task for k trials each and grade every trial — the one
 * parameterized runner behind every eval mode (k=1 debugging, k=3
 * consistency, subsets, full suite).
 *
 * Trials run sequentially (checkpoint-1 baseline). Each trial is one
 * deps.runTask call; its oracle is fetched at grading time, and its grader
 * is handed exactly the trial's run directory path and that oracle data —
 * nothing else (the design's standing rule).
 *
 * @param tasks - the tasks to evaluate, in order; throws if empty
 * @param k - trials per task; throws unless a positive integer
 * @param deps - the injected agent; each trial awaits one runTask call
 * @returns a report with per-trial grades and latencies and per-task
 *   aggregate metrics (accuracy, completion, task pass); throws if a grader
 *   returns zero assertions
 */
export async function runEvals(
  tasks: EvalTask[],
  k: number,
  deps: EvalRunnerDeps,
): Promise<EvalReport> {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k must be a positive integer, got ${k}`);
  }
  if (tasks.length === 0) {
    throw new Error('no tasks to run');
  }

  const startedAt = new Date().toISOString();
  const taskReports: TaskReport[] = [];
  for (const task of tasks) {
    const trials: TrialGrade[] = [];
    for (let i = 0; i < k; i++) {
      const runStart = performance.now();
      const { runDir } = await deps.runTask(task.taskText, { startUrl: task.startUrl });
      const latencyMs = performance.now() - runStart;

      // Ground truth is fetched at grading time, per trial — Tier A oracles
      // must reflect the live source as it stands when the grade is taken.
      const oracleData = await task.fetchOracle();

      // The harness's only grading call site. The grader gets the run dir
      // path and oracle data — never a transcript or conversation — so the
      // standing rule holds for every grader by construction.
      const assertions = await task.grade(runDir, oracleData);
      if (assertions.length === 0) {
        throw new Error(`grader for task "${task.name}" returned no assertions`);
      }
      const grade: TrialGrade = { runDir, assertions, latencyMs };
      trials.push(grade);
      await deps.onTrialGraded?.(task.name, i, grade);
    }
    taskReports.push(summarizeTask(task.name, trials));
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    k,
    model: deps.model,
    toolProfile: deps.toolProfile,
    tasks: taskReports,
  };
}
