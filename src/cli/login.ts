// Login helper for the persistent headed-lane Chrome profile.
//
//   npm run login            interactive: open the profile, log in by
//                            hand, press Enter to verify; loops until
//                            every service verifies or you quit
//   npm run login -- --check verify only (headless, no interaction);
//                            exit 0 iff every service is logged in —
//                            usable as a pre-batch preflight
//
// Why this exists: headed eval trials launch whatever sessions live in
// ONE specific profile directory (repo-anchored in a dev checkout, so
// every worktree has its own), and pre-batch logins kept silently
// landing somewhere else. This helper resolves the profile and the
// Chrome binary through the exact same code path the trials use, then
// verifies behaviorally — a page that loads signed-in cannot lie.

import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { BrowserContext } from 'playwright';

import { launchPersistentChrome } from '../browser/playwrightBrowserController.js';
import {
  chromeExecutablePath,
  findDevRoot,
  resolveSherlockPaths,
} from '../config/paths.js';
import { probeServices } from './loginCheck.js';
import { HEADED_LANE_SERVICES, allLoggedIn, formatLoginState } from './loginProbe.js';

const PROBE_NAVIGATION_TIMEOUT_MS = 20_000;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const paths = resolveSherlockPaths({ devRoot: findDevRoot(PACKAGE_ROOT) });
const checkOnly = process.argv.includes('--check');

console.log(`Chrome profile: ${paths.profileDir}`);
console.log('(the exact directory headed eval trials launch — logins anywhere else do not count)');

/** Probe every headed-lane service, print one status line each. */
async function verifyAll(context: BrowserContext): Promise<boolean> {
  const statuses = await probeServices(context, HEADED_LANE_SERVICES, (status) => {
    console.log(`  ${status.service.name}: ${formatLoginState(status.state)}`);
  });
  return allLoggedIn(statuses);
}

const context = await launchPersistentChrome({
  profileDir: paths.profileDir,
  executablePath: chromeExecutablePath(),
  headless: checkOnly,
});

try {
  if (checkOnly) {
    console.log('Verifying login state (headless)…');
    const ready = await verifyAll(context);
    console.log(ready
      ? `\nLOGIN OK — ${paths.profileDir} is ready for headed batches.`
      : '\nNOT READY — run `npm run login` (no --check) to log in interactively.');
    process.exitCode = ready ? 0 : 1;
  } else {
    // One tab per service so each sign-in page is right there to act on.
    const pages = context.pages();
    for (let i = 0; i < HEADED_LANE_SERVICES.length; i += 1) {
      const page = pages[i] ?? (await context.newPage());
      await page
        .goto(HEADED_LANE_SERVICES[i]!.probeUrl, {
          waitUntil: 'domcontentloaded',
          timeout: PROBE_NAVIGATION_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.exitCode = 1;
      for (;;) {
        const answer = await rl.question(
          '\nComplete the logins in the Chrome window, then press Enter to verify (q to quit): ',
        );
        if (answer.trim().toLowerCase() === 'q') break;
        console.log('Verifying…');
        if (await verifyAll(context)) {
          console.log(`\nLOGIN OK — ${paths.profileDir} is ready for headed batches.`);
          process.exitCode = 0;
          break;
        }
        console.log('Fix the failing login in the Chrome window, then verify again.');
      }
    } finally {
      rl.close();
    }
  }
} finally {
  await context.close().catch(() => undefined);
}
