import { DEFAULT_EVAL_CONCURRENCY, DEFAULT_K } from '../config.js';
import type { ContractAuthor } from '../../src/harness/initializer.js';

/** The eval CLI's parsed parameters: which tasks, how many trials. */
export interface EvalCliArgs {
  /** Task names to run, in order, at least one. */
  tasks: string[];
  /** Trials per task, a positive integer. */
  k: number;
  /** Maximum simultaneous normal/headless trials. */
  concurrency: number;
  /** Who states the typed output contract every batch runs. */
  contractAuthor: ContractAuthor;
  /** Skip the pre-batch login gate and run even if a required session is
   * missing — the escape hatch for deliberately measuring what the agent
   * does at a login wall. */
  skipLoginCheck: boolean;
}

/**
 * Parse the eval CLI's arguments: `--tasks <a,b,c>` (required) and
 * `--k <n>` (optional, default 1). Both `--flag value` and `--flag=value`
 * are accepted. `--skip-login-check` is a bare boolean flag.
 *
 * @param argv - the arguments after the script name (process.argv.slice(2))
 * @returns the task names (comma-split, trimmed, blanks dropped) and k;
 *   throws on an unknown flag, a missing value, no tasks, or a k that is
 *   not a positive integer
 */
export function parseEvalArgs(argv: string[]): EvalCliArgs {
  let tasksRaw: string | undefined;
  let kRaw: string | undefined;
  let concurrencyRaw: string | undefined;
  let contractAuthorRaw: string | undefined;
  let skipLoginCheck = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${flag}`);
      return next;
    };

    if (flag === '--tasks') tasksRaw = takeValue();
    else if (flag === '--k') kRaw = takeValue();
    else if (flag === '--concurrency') concurrencyRaw = takeValue();
    else if (flag === '--contract-author') contractAuthorRaw = takeValue();
    else if (flag === '--skip-login-check') skipLoginCheck = true;
    else throw new Error(
      `unknown argument ${JSON.stringify(arg)} ` +
        '(usage: --tasks <a,b,c> [--k <n>] [--concurrency <n>] ' +
          '[--contract-author initializer|worker] [--skip-login-check])',
    );
  }

  if (tasksRaw === undefined) {
    throw new Error('--tasks is required (e.g. --tasks stub)');
  }
  const tasks = tasksRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (tasks.length === 0) {
    throw new Error('--tasks must name at least one task');
  }

  let k = DEFAULT_K;
  if (kRaw !== undefined) {
    k = Number(kRaw);
    if (!Number.isInteger(k) || k < 1) {
      throw new Error(`--k must be a positive integer, got ${JSON.stringify(kRaw)}`);
    }
  }
  let concurrency = DEFAULT_EVAL_CONCURRENCY;
  if (concurrencyRaw !== undefined) {
    concurrency = Number(concurrencyRaw);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `--concurrency must be a positive integer, got ${JSON.stringify(concurrencyRaw)}`,
      );
    }
  }

  const contractAuthor = contractAuthorRaw ?? 'initializer';
  if (contractAuthor !== 'initializer' && contractAuthor !== 'worker') {
    throw new Error(
      `--contract-author must be "initializer" or "worker", got ` +
        `${JSON.stringify(contractAuthorRaw)}`,
    );
  }

  return { tasks, k, concurrency, contractAuthor, skipLoginCheck };
}
