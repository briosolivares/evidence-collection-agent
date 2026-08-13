import type { AssertionResult } from '../types.js';

/** The outcome of one trial: its run dir, assertion results, and latency —
 * or, for a trial whose run/grading pipeline threw, the error that ended it. */
export interface TrialGrade {
  /** Absolute path of the trial's run directory; absent only when the
   * trial errored before its run directory was known. */
  runDir?: string;
  /** The grader's assertion results for this trial; empty exactly when
   * `error` is set (an errored trial was never graded). */
  assertions: AssertionResult[];
  /** Wall-clock duration of the agent run (excluding grading), in ms. */
  latencyMs: number;
  /** Why this trial has no grade: its run or grading threw. An errored
   * trial scores zero accuracy and never counts as completed. */
  error?: string;
}

/** A trial's grade plus its derived completion flag. */
export interface TrialReport extends TrialGrade {
  /** True iff every assertion in this trial passed (design: "completion"). */
  completed: boolean;
}

/** Aggregated metrics for one task over its k trials. */
export interface TaskReport {
  /** The task's name. */
  task: string;
  /** Number of trials aggregated. */
  k: number;
  /** Mean fraction of assertions passed across trials, in [0, 1]. */
  accuracy: number;
  /** True iff all k trials completed (design: "task passes"). */
  taskPassed: boolean;
  /** Mean of the trials' latencies, in ms. */
  meanLatencyMs: number;
  /** The per-trial grades, in trial order. */
  trials: TrialReport[];
}

/**
 * Fraction of a trial's assertions that passed.
 *
 * @param assertions - the trial's assertion results; throws if empty (a
 *   grader that asserts nothing has graded nothing — that is a harness bug,
 *   not a score of zero)
 * @returns passed count / total count, in [0, 1]
 */
export function fractionPassed(assertions: AssertionResult[]): number {
  if (assertions.length === 0) {
    throw new Error('cannot score a trial with zero assertions');
  }
  return assertions.filter((a) => a.passed).length / assertions.length;
}

/**
 * Whether a trial completed — the design's per-trial completion metric.
 *
 * @param assertions - the trial's assertion results; throws if empty (see
 *   fractionPassed)
 * @returns true iff every assertion passed
 */
export function isComplete(assertions: AssertionResult[]): boolean {
  if (assertions.length === 0) {
    throw new Error('cannot score a trial with zero assertions');
  }
  return assertions.every((a) => a.passed);
}

/**
 * Aggregate one task's trial grades into the design's metrics: accuracy
 * (mean fraction of assertions passed across trials), per-trial completion,
 * task pass (all trials complete), and mean latency.
 *
 * @param taskName - the task's name, copied into the report
 * @param trials - one grade per trial, in trial order; throws if empty or
 *   if any non-errored trial has zero assertions. An errored trial scores
 *   zero accuracy and is never completed.
 * @returns the task's report, with k = trials.length and each trial carrying
 *   its derived completion flag
 */
export function summarizeTask(taskName: string, trials: TrialGrade[]): TaskReport {
  if (trials.length === 0) {
    throw new Error(`cannot summarize task "${taskName}" with zero trials`);
  }
  const trialReports: TrialReport[] = trials.map((t) => ({
    ...t,
    completed: t.error === undefined && isComplete(t.assertions),
  }));
  return {
    task: taskName,
    k: trials.length,
    accuracy: mean(trials.map((t) => (t.error === undefined ? fractionPassed(t.assertions) : 0))),
    taskPassed: trialReports.every((t) => t.completed),
    meanLatencyMs: mean(trials.map((t) => t.latencyMs)),
    trials: trialReports,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
