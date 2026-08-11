import { DEFAULT_K } from '../config.js';

/** The eval CLI's parsed parameters: which tasks, how many trials. */
export interface EvalCliArgs {
  /** Task names to run, in order, at least one. */
  tasks: string[];
  /** Trials per task, a positive integer. */
  k: number;
}

/**
 * Parse the eval CLI's arguments: `--tasks <a,b,c>` (required) and
 * `--k <n>` (optional, default 1). Both `--flag value` and `--flag=value`
 * are accepted.
 *
 * @param argv - the arguments after the script name (process.argv.slice(2))
 * @returns the task names (comma-split, trimmed, blanks dropped) and k;
 *   throws on an unknown flag, a missing value, no tasks, or a k that is
 *   not a positive integer
 */
export function parseEvalArgs(argv: string[]): EvalCliArgs {
  let tasksRaw: string | undefined;
  let kRaw: string | undefined;

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
    else throw new Error(`unknown argument ${JSON.stringify(arg)} (usage: --tasks <a,b,c> [--k <n>])`);
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
  return { tasks, k };
}
