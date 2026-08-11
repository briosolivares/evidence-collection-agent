// T15: the terminal REPL — the product's thin interactive interface (see
// design/detailed-design.md "Interface: an interactive terminal agent").
// Deliberately minimal: Node's built-in readline, no TUI framework, no
// slash commands. One persistent, headed, logged-in Chrome session backs
// every task typed into the session, so logins and other warm state carry
// across tasks. Run with:
//
//   npx tsx src/cli/repl.ts
//
// (the coordinator wires this up as `npm run agent`). Requires
// ANTHROPIC_API_KEY (or another SDK-supported credential source); this is
// the interactive product entry point, not a test — it is never invoked by
// the automated suite.

import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import { formatProgressEvent, formatRunSummary } from './replFormat.js';
import { runTask } from './runTask.js';

const PROFILE_DIR = resolve('chrome-profile');
const RUNS_BASE_DIR = 'runs';
const PROMPT = '\ntask> ';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    'warning: ANTHROPIC_API_KEY is not set — the SDK will try its other ambient ' +
      'credential sources; without any, the first model call will fail.',
  );
}

console.log(`Chrome profile: ${PROFILE_DIR}`);
console.log(`runs directory: ${RUNS_BASE_DIR}`);
console.log('Type a task and press enter. Ctrl-C or Ctrl-D ends the session.');

const browserSessionProvider = new LocalChromeBrowserSessionProvider({
  profileDir: PROFILE_DIR,
});
const browser = await browserSessionProvider.createSession();
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
        onProgress: (event) => process.stdout.write(formatProgressEvent(event)),
      });
      process.stdout.write(formatRunSummary(result));
    } catch (error) {
      // One failed task must not end the session or leak the browser — the
      // point of a session-long browser is that later tasks keep working.
      console.error(`\ntask failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    rl.prompt();
  }
} finally {
  rl.close();
  await browser.close();
}
