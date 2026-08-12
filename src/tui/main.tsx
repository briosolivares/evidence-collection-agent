// Sherlock entry point: env load, preflight, persistent-browser launch,
// render(<App/>), teardown.
import { render } from 'ink';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import {
  findDevRoot,
  loadFirstEnvFile,
  resolveSherlockPaths,
} from '../config/paths.js';
// Read-only import of the core's default model id for the welcome card —
// the sanctioned touch-point; the core itself stays untouched.
import { DEFAULT_MODEL } from '../model/callModel.js';
import { createTuiRuntime } from './bridge/runtime.js';
import { App } from './components/App.js';
import { createConfig } from './config.js';
import type { BannerIdentity } from './store/state.js';

/** First word of `git config user.name`, else the OS username
 * capitalized — the name the welcome card greets. */
function detectFirstName(): string {
  try {
    const configured = execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = configured.split(/\s+/)[0];
    if (first !== undefined && first !== '') return first;
  } catch {
    // No git, or no configured name — fall back to the OS username.
  }
  const { username } = userInfo();
  return username.charAt(0).toUpperCase() + username.slice(1);
}

/** The working directory with the home prefix shortened to `~`. */
function shortenedCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return home !== '' && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Value of `--flag <value>` or `--flag=<value>`, else undefined. */
function argValue(flag: string): string | undefined {
  const withEquals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (withEquals !== undefined) return withEquals.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Per-user state locations: repo-anchored in a dev checkout, under
// ~/.sherlock when installed — see src/config/paths.ts for the rules.
const paths = resolveSherlockPaths({ devRoot: findDevRoot(PACKAGE_ROOT) });

// The repo deliberately has no dotenv; Sherlock loads the first .env it
// finds so a bare `sherlock` works without flags. All candidates being
// absent is fine — the SDK falls back to ambient credentials — but an
// explicitly requested --env-file must load.
const envFileFlag = argValue('--env-file');
let loadedEnvFile: string | undefined;
if (envFileFlag !== undefined) {
  loadedEnvFile = loadFirstEnvFile([resolve(envFileFlag)]);
  if (loadedEnvFile === undefined) {
    console.error(`could not read --env-file ${envFileFlag}`);
    process.exit(1);
  }
} else {
  loadedEnvFile = loadFirstEnvFile(paths.envFileCandidates);
}

// The Node ≥22 floor is enforced in bin/sherlock.mjs, before any of
// this module's imports (Ink 7 among them) get a chance to load.

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(
    'sherlock is an interactive TUI and needs an interactive terminal (TTY); ' +
      'run it directly in a terminal.',
  );
  process.exit(1);
}

// Welcome-card identity, computed here at the edge (the reducer stays
// pure — it only ever sees these as injected values).
const identity: BannerIdentity = {
  name: detectFirstName(),
  model: DEFAULT_MODEL,
  cwd: shortenedCwd(),
};

const demo = process.argv.includes('--demo');
const verbose = process.argv.includes('--verbose');
const runsDirFlag = argValue('--runs-dir');
const runsBaseDir =
  runsDirFlag !== undefined ? resolve(runsDirFlag) : paths.runsBaseDir;
const config = createConfig({
  verbose,
  runsBaseDir,
  evalsDir: paths.evalsDir,
  evalResultsDir:
    runsDirFlag !== undefined
      ? resolve(runsBaseDir, 'eval-results')
      : paths.evalResultsDir,
});

if (verbose) {
  console.error(
    loadedEnvFile !== undefined
      ? `env: loaded ${loadedEnvFile}`
      : 'env: no .env file found; using the ambient environment only',
  );
}

// One persistent, headed Chrome for the whole session (same profile-dir
// semantics as the REPL); each run gets a fresh tab. The demo needs no
// browser — it never leaves the UI pipeline.
const runtime = demo
  ? undefined
  : createTuiRuntime({
      browserSessionProvider: new LocalChromeBrowserSessionProvider({
        profileDir: paths.profileDir,
      }),
      runsBaseDir: config.runsBaseDir,
    });
await runtime?.start();

try {
  const instance = render(
    <App
      config={config}
      apiKeyPresent={Boolean(process.env.ANTHROPIC_API_KEY)}
      identity={identity}
      demo={demo}
      runner={
        runtime === undefined
          ? undefined
          : (task, onEvent, opts) => runtime.startRun(task, onEvent, opts)
      }
    />,
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
} finally {
  await runtime?.shutdown();
}
