// Sherlock entry point: env load, preflight, persistent-browser launch,
// render(<App/>), teardown.
import { render } from 'ink';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
import { createTuiRuntime } from './bridge/runtime.js';
import { App } from './components/App.js';
import { createConfig } from './config.js';

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

const demo = process.argv.includes('--demo');
const config = createConfig({
  verbose: process.argv.includes('--verbose'),
  runsBaseDir: resolve(REPO_ROOT, 'runs'),
  evalsDir: resolve(REPO_ROOT, 'evals'),
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
