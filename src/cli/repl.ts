// T15: the terminal REPL — the product's thin interactive interface (see
// design/detailed-design.md "Interface: an interactive terminal agent").
// Deliberately minimal: Node's built-in readline, no TUI framework, no
// slash commands. One persistent, logged-in browser session backs every task
// typed into the session, so logins and other warm state carry across tasks.
// Which runtime hosts it — a headed local Chrome or a Browserbase session — is
// the environment's choice; see src/browser/provider.ts. Run with:
//
//   npx tsx src/cli/repl.ts
//
// (the coordinator wires this up as `npm run agent`). Requires
// ANTHROPIC_API_KEY (or another SDK-supported credential source); this is
// the interactive product entry point, not a test — it is never invoked by
// the automated suite.

import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { BrowserController } from '../browser/controller.js';
import {
  createBrowserSessionProvider,
  describeBrowserProvider,
  formatBrowserStartupError,
  resolveBrowserProviderKind,
} from '../browser/provider.js';
import type { BrowserSessionProvider } from '../browser/sessionProvider.js';
import {
  chromeExecutablePath,
  findDevRoot,
  loadFirstEnvFile,
  resolveSherlockPaths,
} from '../config/paths.js';
import { isBrowserDeathMessage } from '../tui/bridge/runtime.js';
import { formatProgressEvent, formatRunSummary } from './replFormat.js';
import { runTask } from './runTask.js';

// Repo-anchored in a checkout, ~/.sherlock installed — never cwd-bound:
// a cwd-relative profile dir silently trades every saved login for a
// fresh empty profile when the REPL is started from anywhere else.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const paths = resolveSherlockPaths({ devRoot: findDevRoot(PACKAGE_ROOT) });
const PROFILE_DIR = paths.profileDir;
const RUNS_BASE_DIR = paths.runsBaseDir;
const PROMPT = '\ntask> ';

// Same .env resolution the TUI uses — without it this entry point could not
// see SHERLOCK_BROWSER_PROVIDER or BROWSERBASE_API_KEY, and would run on local
// Chrome in a project configured to run remotely.
loadFirstEnvFile(paths.envFileCandidates);

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    'warning: ANTHROPIC_API_KEY is not set — the SDK will try its other ambient ' +
      'credential sources; without any, the first model call will fail.',
  );
}

const executablePath = chromeExecutablePath();

let browserSessionProvider: BrowserSessionProvider;
let browser: BrowserController;
try {
  console.log(
    describeBrowserProvider({
      profileDir: PROFILE_DIR,
      localMode: 'managed',
    }),
  );
  console.log(`runs directory: ${RUNS_BASE_DIR}`);
  console.log('Type a task and press enter. Ctrl-C or Ctrl-D ends the session.');

  browserSessionProvider = createBrowserSessionProvider({
    localMode: 'managed',
    profileDir: PROFILE_DIR,
    ...(executablePath === undefined ? {} : { executablePath }),
    // The REPL is an interactive, logged-in surface, exactly like the TUI's
    // session browser; `optional` so a user without a Context can still work.
    context: 'optional',
  });
  browser = await browserSessionProvider.createSession();
} catch (error) {
  // A misconfigured provider (unknown SHERLOCK_BROWSER_PROVIDER, missing API
  // key) and a browser that would not start deserve the same actionable
  // sentence, not a stack trace over the top of a fresh prompt.
  console.error(
    formatBrowserStartupError(
      resolveBrowserProviderKindOrLocal(),
      error instanceof Error ? error.message : String(error),
      'managed',
    ),
  );
  process.exit(1);
}
announceSession(browser);

/** The selected provider, or `local` when the value is what is broken — the
 * fallback only decides which advice the error message carries. */
function resolveBrowserProviderKindOrLocal(): 'local' | 'browserbase' {
  try {
    return resolveBrowserProviderKind();
  } catch {
    return 'local';
  }
}

/**
 * Print a remote session's Live View link.
 *
 * A local Chrome window is already on screen and needs no announcement; a
 * remote one is invisible until someone is told where to look, which matters
 * most in exactly the case a human has to take over (a re-auth prompt
 * mid-task).
 */
function announceSession(session: BrowserController): void {
  const diagnostics = session.sessionDiagnostics;
  if (diagnostics === undefined || diagnostics.provider === 'local') return;
  console.log(`browser session: ${diagnostics.sessionId ?? '(unknown id)'}`);
  if (diagnostics.liveViewUrl !== undefined) {
    console.log(`live view:       ${diagnostics.liveViewUrl}`);
  }
}

/**
 * Replace a dead session browser with a fresh one.
 *
 * A remote session can end under the REPL for reasons a local Chrome never
 * has — its own timeout, a network drop, an inactivity limit — and without
 * this the first such death would make every remaining task in the session
 * fail identically, with no way out but restarting. This mirrors the TUI's
 * next-run relaunch behavior and uses the same death classifier, so both
 * surfaces agree on what counts as a dead browser.
 *
 * @returns true when a replacement session is live
 */
async function relaunchBrowser(): Promise<boolean> {
  try {
    await browser.close();
  } catch {
    // A dead browser has nothing left to close.
  }
  try {
    browser = await browserSessionProvider.createSession();
    console.log('\nbrowser session ended — started a fresh one for the next task.');
    announceSession(browser);
    return true;
  } catch (error) {
    console.error(
      `\nbrowser session ended and could not be replaced: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

// Node's readline only pauses input on Ctrl-C by default (it neither exits
// nor closes the interface); an explicit 'SIGINT' listener that closes the
// interface is what ends the `for await` loop below and reaches the
// `finally` block. A task already running when Ctrl-C is pressed is
// allowed to finish — runTask always closes its own tab on the way out, so
// the browser is left in a clean, reusable state either way.
rl.on('SIGINT', () => rl.close());

try {
  rl.prompt();
  for await (const line of rl) {
    const taskText = line.trim();
    if (taskText === '') {
      rl.prompt();
      continue;
    }

    try {
      const result = await runTask(taskText, {
        browser,
        runsBaseDir: RUNS_BASE_DIR,
        authenticated: true,
        javascriptPolicy: 'allow',
        onProgress: (event) => process.stdout.write(formatProgressEvent(event)),
      });
      process.stdout.write(formatRunSummary(result));
    } catch (error) {
      // One failed task must not end the session or leak the browser — the
      // point of a session-long browser is that later tasks keep working.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\ntask failed: ${message}`);
      // Unless the browser itself is what died, in which case every later
      // task would fail the same way against the same corpse. Relaunch now
      // rather than at the next task's first browser call, so the next prompt
      // is offered against a session that is known to be live.
      if (isBrowserDeathMessage(message) && !(await relaunchBrowser())) break;
    }

    rl.prompt();
  }
} finally {
  rl.close();
  await browser.close();
}
