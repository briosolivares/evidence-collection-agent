// Sherlock entry point: env load, preflight, persistent-browser launch,
// render(<App/>), teardown.
import { render } from 'ink';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The repo deliberately has no dotenv; Sherlock loads the gitignored .env
// itself so a bare `sherlock` works without `--env-file`. An absent file
// is fine — the SDK falls back to ambient credentials.
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // No .env — ambient environment only.
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  console.error(
    `sherlock requires Node 22 or newer (Ink 7); this is Node ${process.versions.node}.`,
  );
  process.exit(1);
}

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
const config = createConfig({
  verbose: process.argv.includes('--verbose'),
  runsBaseDir: resolve(REPO_ROOT, 'runs'),
  evalsDir: resolve(REPO_ROOT, 'evals/datasets'),
  evalResultsDir: resolve(REPO_ROOT, 'runs', 'eval-results'),
});

// One persistent, headed Chrome for the whole session (same profile-dir
// semantics as the REPL); each run gets a fresh tab. The demo needs no
// browser — it never leaves the UI pipeline.
const runtime = demo
  ? undefined
  : createTuiRuntime({
      launchBrowser: () =>
        launchPersistentChrome({ profileDir: resolve(REPO_ROOT, 'chrome-profile') }),
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
