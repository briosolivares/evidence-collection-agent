// Where Sherlock keeps per-user state (Chrome profile, runs, eval
// results, .env). Two modes, decided by the caller:
//
// - dev checkout (`devRoot` set — the package root has a .git marker):
//   everything stays repo-anchored exactly as it always has — `runs/`,
//   `chrome-profile/`, and `.env` at the repo root.
// - installed CLI (no `devRoot`): everything lives under one data home
//   (`~/.sherlock` by default), because the package directory under a
//   global npm prefix is often root-owned and never where a user would
//   look for evidence, and cwd-anchoring would scatter state across
//   whatever directory the user happened to launch from.
//
// Explicit environment overrides win over either mode: SHERLOCK_HOME
// moves the whole data home, SHERLOCK_RUNS_DIR moves just the runs base.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** The resolved per-user state locations. All paths are absolute. */
export interface SherlockPaths {
  /** Root of Sherlock's own state (`~/.sherlock` unless overridden). */
  dataHome: string;
  /** Persistent Chrome profile — logins survive across runs. */
  profileDir: string;
  /** Base directory each new run directory is created under. */
  runsBaseDir: string;
  /** Directory holding eval task datasets (`<name>/task.json`). */
  evalsDir: string;
  /** Where eval invocations write their results JSON. */
  evalResultsDir: string;
  /** `.env` files to try in order; the first that loads wins. */
  envFileCandidates: string[];
}

/** Inputs for {@link resolveSherlockPaths}; all injectable for tests. */
export interface ResolvePathsOptions {
  /** Environment to read overrides from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Absolute package root when running from a git checkout; leaves
   * state repo-anchored. Omit for installed (data-home) behavior. */
  devRoot?: string;
  /** Base for resolving relative override values; defaults to cwd. */
  cwd?: string;
  /** Home directory; defaults to `os.homedir()`. */
  home?: string;
}

/**
 * Resolve every per-user state location from one place. Precedence per
 * location: explicit env override, then dev checkout root, then the
 * data home under `~`.
 */
export function resolveSherlockPaths(options: ResolvePathsOptions = {}): SherlockPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();

  const dataHome =
    env.SHERLOCK_HOME !== undefined && env.SHERLOCK_HOME !== ''
      ? resolve(cwd, env.SHERLOCK_HOME)
      : resolve(home, '.sherlock');

  // SHERLOCK_HOME is an explicit request for data-home behavior even
  // inside a checkout; only a plain dev checkout stays repo-anchored.
  const devRoot =
    env.SHERLOCK_HOME !== undefined && env.SHERLOCK_HOME !== '' ? undefined : options.devRoot;
  const stateRoot = devRoot ?? dataHome;

  const runsBaseDir =
    env.SHERLOCK_RUNS_DIR !== undefined && env.SHERLOCK_RUNS_DIR !== ''
      ? resolve(cwd, env.SHERLOCK_RUNS_DIR)
      : resolve(stateRoot, 'runs');

  return {
    dataHome,
    profileDir: resolve(stateRoot, 'chrome-profile'),
    runsBaseDir,
    evalsDir: resolve(stateRoot, 'evals/datasets'),
    evalResultsDir: resolve(runsBaseDir, 'eval-results'),
    envFileCandidates:
      devRoot !== undefined
        ? [resolve(devRoot, '.env')]
        : [resolve(cwd, '.env'), resolve(dataHome, '.env')],
  };
}

/**
 * Optional Chrome/Chromium binary override (SHERLOCK_CHROME_PATH). When
 * unset, Playwright discovers system Google Chrome via its `chrome`
 * channel — which has no answer for Chromium-only Linux boxes or
 * non-standard install locations; this is the escape hatch.
 */
export function chromeExecutablePath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.SHERLOCK_CHROME_PATH;
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * The dev-checkout marker: the package root is a git checkout (a `.git`
 * directory, or a `.git` file in a linked worktree). Installed packages
 * — `npm install -g`, git installs included — never carry `.git`.
 */
export function findDevRoot(packageRoot: string): string | undefined {
  return existsSync(resolve(packageRoot, '.git')) ? packageRoot : undefined;
}

/**
 * Load the first `.env` file that exists from `candidates`, in order.
 *
 * @returns the path that loaded, or undefined when none exists —
 *   ambient environment variables are then the only credential source
 */
export function loadFirstEnvFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return undefined;
}
