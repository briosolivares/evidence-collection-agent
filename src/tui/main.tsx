// Sherlock entry point: env load, preflight, lazy browser runtimes,
// render(<App/>), teardown.
import { render } from 'ink';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import {
  chromeExecutablePath,
  findDevRoot,
  loadFirstEnvFile,
  resolveSherlockPaths,
} from '../config/paths.js';
// Read-only import of the core's default model id for the welcome card —
// the sanctioned touch-point; the core itself stays untouched.
import { DEFAULT_MODEL } from '../model/callModel.js';
import { createTuiEvalRuntime } from './bridge/evalRuntime.js';
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

/** One-time key setup: ask on stdin, optionally persist. Runs before
 * Ink renders and before Chrome launches, so a missing key is fixed
 * here instead of surfacing as a 401 halfway through the first run.
 * Skipping is allowed — the welcome card then shows its warning. */
async function promptForApiKey(
  checked: string[],
  saveTarget: string,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`No Anthropic API key found (checked ${checked.join(', ')}).`);
    const key = (
      await rl.question('Paste an API key to use (Enter to skip): ')
    ).trim();
    if (key === '') return;
    process.env.ANTHROPIC_API_KEY = key;
    const save = (
      await rl.question(`Save it to ${saveTarget} for future sessions? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    if (save === '' || save === 'y' || save === 'yes') {
      mkdirSync(dirname(saveTarget), { recursive: true });
      appendFileSync(saveTarget, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
      console.log('Saved — future sessions load it automatically.');
    }
  } catch {
    // Ctrl+D (EOF) or a closed stream at either question means skip —
    // the welcome card's warning banner takes it from here.
  } finally {
    rl.close();
  }
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

// Key preflight: catch the missing-credential case while the terminal
// is still plain stdin, not after Chrome is already on screen. The SDK
// also honors ANTHROPIC_AUTH_TOKEN, so only a fully bare environment
// prompts. Saving targets the last .env candidate — the repo .env in a
// checkout, ~/.sherlock/.env installed.
if (
  !demo &&
  process.env.ANTHROPIC_API_KEY === undefined &&
  process.env.ANTHROPIC_AUTH_TOKEN === undefined
) {
  const candidates = paths.envFileCandidates;
  await promptForApiKey(
    ['the environment', ...candidates],
    candidates[candidates.length - 1]!,
  );
}

// The headed persistent browser launches lazily on the first interactive
// or authenticated run. Normal evals use the separate headless runtime.
const browserExecutablePath = chromeExecutablePath();
const runtime = demo
  ? undefined
  : createTuiRuntime({
      browserSessionProvider: new LocalChromeBrowserSessionProvider({
        profileDir: paths.profileDir,
        executablePath: browserExecutablePath,
      }),
      runsBaseDir: config.runsBaseDir,
    });
try {
  await runtime?.start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('sherlock could not launch Chrome.');
  if (/not found|install|doesn'?t exist|does not exist/i.test(message)) {
    console.error(
      'Google Chrome does not appear to be installed. Install it from ' +
        'https://www.google.com/chrome/ (or run `npx playwright install chrome`), ' +
        'or point SHERLOCK_CHROME_PATH at a Chrome/Chromium binary.',
    );
  }
  console.error(`\n${message}`);
  process.exit(1);
}
const evalRuntime =
  runtime === undefined
    ? undefined
    : createTuiEvalRuntime({
        authenticatedRunner: (task, onEvent, opts) => runtime.startRun(task, onEvent, opts),
        authenticatedProfileDir: paths.profileDir,
        browserExecutablePath,
        runsBaseDir: config.runsBaseDir,
      });

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
      evalRunner={evalRuntime?.startRun}
    />,
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
} finally {
  await evalRuntime?.close();
  await runtime?.shutdown();
}
