/**
 * Central configuration for the eval harness: where the pieces of the
 * harness live on disk and the defaults the runners start from. Every
 * runner-facing path constant belongs here — runners import these rather
 * than building their own paths.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL } from '../src/model/callModel.js';

/**
 * Directory holding the eval task datasets. Each dataset is one directory
 * named after the task, containing `task.json` (input task text + start
 * URL), `oracle/` (fetches live expected output), and `grader/` (checks a
 * run directory against the oracle).
 */
export const DATASETS_DIR = fileURLToPath(new URL('./datasets/', import.meta.url));

/**
 * Where trial run directories are created — the same gitignored home as
 * real (non-eval) runs, so graders and humans inspect both the same way.
 */
export const RUNS_DIR = 'runs';

/**
 * Where each eval invocation writes its results JSON (one file per
 * invocation, named with a fresh run id). Gitignored except for .gitkeep.
 */
export const EXPERIMENTS_DIR = fileURLToPath(new URL('./experiments/', import.meta.url));

/** Persistent Chrome profile shared with the REPL and demos. */
export const PROFILE_DIR = resolve('chrome-profile');

/** Trials per task when --k is not given (the k=1 debugging inner loop). */
export const DEFAULT_K = 1;

/** Maximum simultaneous normal/headless eval trials. */
export const DEFAULT_EVAL_CONCURRENCY = 3;

/**
 * Model id every eval trial runs with. Defaults to the production model so
 * evals measure what users get; point it at another id here to run an
 * experiment against a different model.
 */
export const MODEL = DEFAULT_MODEL; // 'claude-sonnet-5'
