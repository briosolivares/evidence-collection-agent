import { summarizeTask, type TaskReport, type TrialGrade } from '../metrics/metrics.js';
import type { EvalRunOptions, EvalTask, RunTaskFn } from '../types.js';

export interface EvalTrialJob extends EvalRunOptions {
  /** Input-order position of the task, used only for deterministic result placement. */
  taskIndex: number;
}

/** Cancellation is a batch outcome, not a failed trial or grader assertion. */
export class EvalRunCancelledError extends Error {
  constructor() {
    super('eval batch cancelled');
    this.name = 'EvalRunCancelledError';
  }
}

/** What the runner needs injected: the agent under evaluation. */
export interface EvalRunnerDeps {
  /** Runs one full trial; the real runTask composition or a fake. */
  runTask: RunTaskFn;
  /** Maximum simultaneous normal/headless trials. */
  concurrency: number;
  /** Name of the model every trial uses, recorded verbatim. */
  model: string;
  /** Completion protocol every trial ran. */
  protocol?: EvalProtocol;
  /** Optional batch cancellation signal. */
  signal?: AbortSignal;
  /** Lifecycle hooks carry full job identity so concurrent output stays attributable. */
  onTrialStarted?: (job: EvalTrialJob) => void | Promise<void>;
  onTrialRunFinished?: (
    job: EvalTrialJob,
    runDir: string,
    latencyMs: number,
  ) => void | Promise<void>;
  /** Awaited inside the serialized grading queue for crash-safe persistence. */
  onTrialGraded?: (job: EvalTrialJob, grade: TrialGrade) => void | Promise<void>;
}

/** Completion metadata. New batches have one initializer-authored protocol;
 * `contractAuthor` remains optional only so historical report JSON still
 * renders with its original experiment label. */
export interface EvalProtocol {
  /** The sole production completion path. */
  completion: 'output-contract';
  /** Historical A/B label; current runners never produce it. */
  contractAuthor?: 'initializer' | 'worker';
}

/** The full result of one eval invocation, over all tasks and trials. */
export interface EvalReport {
  /** ISO 8601 timestamp of when the eval run started. */
  startedAt: string;
  /** ISO 8601 timestamp of when the eval run finished. */
  finishedAt: string;
  /** Trials per task this report was run with. */
  k: number;
  /** Maximum simultaneous normal/headless trials. */
  concurrency: number;
  /** Name of the model every trial ran with. */
  model: string;
  /** Completion protocol every trial ran. Absent on reports written before
   * the protocol field existed. */
  protocol?: EvalProtocol;
  /** Number of interactive dialogs a human answered during the batch (TUI
   * headed-lane assists — see the TUI's evalSession). Present only when
   * nonzero: an assisted batch's scores are not comparable to unassisted
   * ones, and this field is the label that keeps them honest. The CLI
   * runner never sets it. */
  assistedDialogs?: number;
  /** One aggregated report per task, in the order the tasks were given. */
  tasks: TaskReport[];
}

/**
 * Run headless trials through a bounded pool and headed trials through
 * a separate serial lane. Browser/model work is concurrent; fresh oracle
 * fetches and grading are serialized independently. Results always return
 * in requested task/trial order.
 *
 * A trial whose run or grading throws is recorded as an errored trial
 * (zero accuracy, task fails) and the batch continues — one bad trial
 * must not discard a long batch. Only caller cancellation aborts the run.
 */
export async function runEvals(
  tasks: EvalTask[],
  k: number,
  deps: EvalRunnerDeps,
): Promise<EvalReport> {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k must be a positive integer, got ${k}`);
  }
  if (!Number.isInteger(deps.concurrency) || deps.concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${deps.concurrency}`);
  }
  if (tasks.length === 0) {
    throw new Error('no tasks to run');
  }

  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const callerAbort = () => controller.abort(new EvalRunCancelledError());
  if (deps.signal?.aborted === true) callerAbort();
  else deps.signal?.addEventListener('abort', callerAbort, { once: true });

  const grades: Array<Array<TrialGrade | undefined>> = tasks.map(() =>
    Array.from<TrialGrade | undefined>({ length: k }).fill(undefined),
  );
  const jobs = createJobs(tasks, k, controller.signal);
  const headlessJobs = jobs.filter((job) => !job.headed);
  const headedJobs = jobs.filter((job) => job.headed);
  let gradingTail: Promise<void> = Promise.resolve();

  // A throwing trial becomes a recorded, failed trial — never a dead batch.
  // Only cancellation (the caller's signal, or a cancelled trial echoing
  // it back as EvalRunCancelledError) aborts the whole run.
  const recordGrade = async (job: EvalTrialJob, grade: TrialGrade) => {
    grades[job.taskIndex]![job.trialIndex] = grade;
    await deps.onTrialGraded?.(job, grade);
  };

  const erroredGrade = (
    error: unknown,
    latencyMs: number,
    runDir?: string,
  ): TrialGrade => ({
    ...(runDir === undefined ? {} : { runDir }),
    assertions: [],
    latencyMs,
    error: error instanceof Error ? error.message : String(error),
  });

  const scheduleErroredTrial = (job: EvalTrialJob, latencyMs: number, error: unknown) => {
    gradingTail = gradingTail.then(async () => {
      if (controller.signal.aborted) return;
      await recordGrade(job, erroredGrade(error, latencyMs));
    });
  };

  const scheduleGrade = (
    task: EvalTask,
    job: EvalTrialJob,
    runDir: string,
    latencyMs: number,
  ) => {
    gradingTail = gradingTail.then(async () => {
      if (controller.signal.aborted) return;
      try {
        // The grader receives exactly the run directory and freshly fetched
        // oracle data. Concurrent execution does not widen this boundary.
        const oracleData = await task.fetchOracle();
        const assertions = await task.grade(runDir, oracleData);
        if (assertions.length === 0) {
          throw new Error(`grader for task "${task.name}" returned no assertions`);
        }
        await recordGrade(job, { runDir, assertions, latencyMs });
      } catch (error) {
        if (controller.signal.aborted) return;
        await recordGrade(job, erroredGrade(error, latencyMs, runDir));
      }
    });
  };

  const runPool = async (queue: EvalTrialJob[], size: number): Promise<void> => {
    let nextIndex = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const job = queue[nextIndex++];
        if (job === undefined) return;
        const task = tasks[job.taskIndex]!;
        const runStart = performance.now();
        try {
          await deps.onTrialStarted?.(job);
          const { runDir } = await deps.runTask(task.taskText, job);
          const latencyMs = performance.now() - runStart;
          if (controller.signal.aborted) return;
          await deps.onTrialRunFinished?.(job, runDir, latencyMs);
          scheduleGrade(task, job, runDir, latencyMs);
        } catch (error) {
          if (controller.signal.aborted) return;
          // Cancellation is an interrupt, never a trial verdict: a
          // cancelled trial must not be recorded as a failed one (it
          // would poison the accuracy report) — it stops the batch.
          if (error instanceof EvalRunCancelledError) {
            controller.abort(error);
            return;
          }
          scheduleErroredTrial(job, performance.now() - runStart, error);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(size, queue.length) }, () => worker()),
    );
  };

  try {
    await Promise.all([
      runPool(headlessJobs, deps.concurrency),
      runPool(headedJobs, 1),
    ]);
    await gradingTail;

    // The controller aborts for exactly one reason — cancellation, from
    // the caller's signal or a cancelled trial echoing up — so an aborted
    // batch reports cancelled, not a partial completion.
    if (controller.signal.aborted) throw new EvalRunCancelledError();

    const taskReports = tasks.map((task, taskIndex) => {
      const taskGrades = grades[taskIndex]!.map((grade, trialIndex) => {
        if (grade === undefined) {
          throw new Error(
            `missing grade for task "${task.name}" trial ${trialIndex + 1} — internal scheduling bug`,
          );
        }
        return grade;
      });
      return summarizeTask(task.name, taskGrades);
    });

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      k,
      concurrency: deps.concurrency,
      model: deps.model,
      ...(deps.protocol === undefined ? {} : { protocol: deps.protocol }),
      tasks: taskReports,
    };
  } finally {
    deps.signal?.removeEventListener('abort', callerAbort);
  }
}

function createJobs(tasks: EvalTask[], k: number, signal: AbortSignal): EvalTrialJob[] {
  return tasks.flatMap((task, taskIndex) =>
    Array.from({ length: k }, (_, trialIndex) => ({
      taskIndex,
      taskName: task.name,
      trialIndex,
      trialNumber: trialIndex + 1,
      k,
      startUrl: task.startUrl,
      headed: task.headed,
      signal,
    })),
  );
}
