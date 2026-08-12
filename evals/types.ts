/**
 * Core contracts of the eval harness: what the agent under evaluation looks
 * like to the runner, and what a grader is allowed to see.
 */

/** Result of one named assertion a grader checked against a run. */
export interface AssertionResult {
  /** Short, stable name of the check (e.g. "csv has 5 rows"). */
  name: string;
  /** Whether the check held. */
  passed: boolean;
  /** Human-readable account of what was found (why it passed or failed). */
  detail: string;
}

/**
 * A grader for one eval task: turns a finished run into assertion results.
 *
 * Standing rule (design, "Evaluation Harness"): a grader receives ONLY the
 * run directory path and the task's oracle data — never a transcript or the
 * conversation. It grades manifest and artifacts, so the evidence must stand
 * on its own; an agent that merely *describes* success in its transcript
 * cannot fool a grader that was never pointed at the transcript.
 *
 * @param runDirPath - absolute path to the run directory of one finished
 *   trial; the grader reads manifest.json and artifact files under it
 * @param oracleData - independent ground truth for this task, as returned by
 *   the task's oracle at grading time; shape is task-specific, so each
 *   grader validates what it receives
 * @returns at least one assertion result; a bad run yields failed assertions
 *   with explanatory detail, never a throw
 */
export type Grader = (
  runDirPath: string,
  oracleData: unknown,
) => AssertionResult[] | Promise<AssertionResult[]>;

/**
 * The agent under evaluation, as the runner sees it: one call runs one full
 * trial and yields the run directory to grade. The real runTask (T14) has a
 * richer result but satisfies this structurally; tests and demos inject a
 * fake.
 *
 * @param taskText - the task the agent should perform, verbatim
 * @param opts - startUrl, when the task declares a starting page
 * @returns the absolute path of the trial's finished run directory,
 *   containing at least a finalized manifest.json
 */
export interface EvalRunOptions {
  /** Starting page declared by the dataset, when present. */
  startUrl?: string;
  /** Stable dataset name, never inferred from task text. */
  taskName: string;
  /** Zero-based trial index used for deterministic result placement. */
  trialIndex: number;
  /** One-based trial number used for human-facing progress. */
  trialNumber: number;
  /** Total trials requested for this task. */
  k: number;
  /** Browser policy declared by the dataset. */
  requiresAuth: boolean;
  /** Aborted when the batch is cancelled or another trial fails fatally. */
  signal: AbortSignal;
}

export type RunTaskFn = (
  taskText: string,
  opts: EvalRunOptions,
) => Promise<{ runDir: string }>;

/** One eval task, loaded from evals/<name>/, ready for the runner. */
export interface EvalTask {
  /** Directory name of the task under evals/ (e.g. "hacker_news"). */
  name: string;
  /** The task text handed to the agent, from task.json. */
  taskText: string;
  /** Starting page for the agent, from task.json, when the task has one. */
  startUrl?: string;
  /** Whether the task must use the shared, logged-in browser identity. */
  requiresAuth: boolean;
  /** Fetches this task's ground truth; called at grading time (Tier A oracles must be fresh). */
  fetchOracle: () => Promise<unknown>;
  /** The task's grader; see Grader for the standing rule it lives under. */
  grade: Grader;
}
