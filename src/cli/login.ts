// Login helper for the authenticated lane, on whichever browser runtime is
// selected (see src/browser/provider.ts).
//
//   npm run login             interactive: sign in by hand and verify;
//                             loops until every service verifies (local),
//                             or signs in through Browserbase Live View
//                             and verifies across a session boundary
//   npm run login -- --manual LOCAL ONLY: launch a plain, un-automated
//                             Chrome on the same profile so Google's
//                             sign-in flow will accept it; quit Chrome
//                             and it verifies
//   npm run login -- --check  verify only, no interaction; exit 0 iff
//                             every service is logged in — this is the
//                             pre-batch preflight
//
// Why this exists: authenticated eval trials use whatever sessions live in
// ONE specific place — a profile directory locally (repo-anchored in a dev
// checkout, so every worktree has its own), or one Browserbase Context
// remotely — and pre-batch logins kept silently landing somewhere else.
// This helper resolves that place through the exact same code path the
// trials use, then verifies behaviorally — a page that loads signed-in
// cannot lie.
//
// Why --manual exists: see manualLogin.ts. Google will not let you sign
// in inside an automated LOCAL browser at all, so the default local mode
// works for X but cannot work for Google. It has no remote analogue: a
// Browserbase browser is only reachable through Live View, which is what
// the Browserbase flow uses.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { BrowserContext } from 'playwright';

import {
  launchPersistentChrome,
  pinProfileDownloadDirectory,
} from '../browser/playwrightBrowserController.js';
import {
  describeBrowserProvider,
  resolveBrowserProviderKind,
} from '../browser/provider.js';
import {
  chromeExecutablePath,
  findDevRoot,
  loadFirstEnvFile,
  resolveSherlockPaths,
} from '../config/paths.js';
import { runBrowserbaseLogin } from './browserbaseLogin.js';
import { checkProfileLogins, probeServices } from './loginCheck.js';
import { HEADED_LANE_SERVICES, allLoggedIn, formatLoginState } from './loginProbe.js';
import {
  MANUAL_LOGIN_START_URL,
  manualLoginArgs,
  resolveRealChromePath,
} from './manualLogin.js';

const PROBE_NAVIGATION_TIMEOUT_MS = 20_000;
/** How long to keep retrying the verification probe while the manually
 * launched Chrome still holds the profile lock. Chrome releases it within a
 * second or two of quitting; this covers a slow shutdown without hanging. */
const PROFILE_RELEASE_RETRY_MS = 20_000;
const PROFILE_RELEASE_POLL_MS = 1_000;
/** Below this, a Chrome exit means "handed off to another instance", not
 * "the human finished signing in". */
const MIN_MANUAL_SESSION_MS = 10_000;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const paths = resolveSherlockPaths({ devRoot: findDevRoot(PACKAGE_ROOT) });
// The same .env resolution the application runtimes use. Without it this
// command could not see SHERLOCK_BROWSER_PROVIDER or BROWSERBASE_API_KEY, and
// would silently log into local Chrome for a project configured to run
// remotely — the exact class of "logged into the wrong place" failure this
// helper exists to end.
const loadedEnvFile = loadFirstEnvFile(paths.envFileCandidates);
/** Where a newly created Browserbase Context id is saved: the file that
 * loaded, or the last candidate (the repo `.env` in a checkout,
 * `~/.sherlock/.env` installed) when none existed yet. */
const envFilePath =
  loadedEnvFile ?? paths.envFileCandidates[paths.envFileCandidates.length - 1]!;
/** Resolve the provider, reporting a misconfiguration as a message rather than
 * a stack trace: the whole failure here is a wrong value in a `.env` line, and
 * a stack trace buries the one sentence that says which. */
function selectedProvider(): 'local' | 'browserbase' {
  try {
    return resolveBrowserProviderKind();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const provider = selectedProvider();
const checkOnly = process.argv.includes('--check');
const manual = process.argv.includes('--manual');

console.log(
  describeBrowserProvider({
    profileDir: paths.profileDir,
    localMode: 'managed',
  }),
);
console.log('(the exact place authenticated eval trials use — logins anywhere else do not count)');

/** Probe every headed-lane service against an open context, printing one
 * status line each. */
async function verifyAll(context: BrowserContext): Promise<boolean> {
  const statuses = await probeServices(context, HEADED_LANE_SERVICES, (status) => {
    console.log(`  ${status.service.name}: ${formatLoginState(status.state)}`);
  });
  return allLoggedIn(statuses);
}

/** Open the profile headlessly and probe it, retrying while another Chrome
 * still holds the lock — the expected state for a few seconds after the
 * manual window is quit. */
async function verifyAfterRelease(): Promise<boolean> {
  const deadline = Date.now() + PROFILE_RELEASE_RETRY_MS;
  for (;;) {
    try {
      const statuses = await checkProfileLogins({
        profileDir: paths.profileDir,
        executablePath: chromeExecutablePath(),
        services: HEADED_LANE_SERVICES,
        headless: true,
        onStatus: (status) => {
          console.log(`  ${status.service.name}: ${formatLoginState(status.state)}`);
        },
      });
      return allLoggedIn(statuses);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      console.log('  (profile still in use by Chrome — waiting for it to quit…)');
      await new Promise((done) => setTimeout(done, PROFILE_RELEASE_POLL_MS));
    }
  }
}

async function runManual(): Promise<void> {
  const chromePath = resolveRealChromePath(chromeExecutablePath());
  if (chromePath === undefined) {
    console.error(
      '\nCould not find a Chrome binary to launch. Set SHERLOCK_CHROME_PATH to it and retry.',
    );
    process.exitCode = 1;
    return;
  }

  // Same reason as the automated launch: Chrome reads this preference at
  // startup, and without it downloads land in the user's ~/Downloads.
  pinProfileDownloadDirectory(paths.profileDir);

  console.log(`\nLaunching a plain Chrome (no automation flags): ${chromePath}`);
  console.log('Google accepts its sign-in flow here; it refuses inside the automated browser.\n');
  const child = spawn(chromePath, manualLoginArgs(paths.profileDir, MANUAL_LOGIN_START_URL), {
    stdio: 'ignore',
    detached: false,
  });
  // Auto-proceed when Chrome quits — but only if it actually stayed open. A
  // Chrome that hands its argv to an already-running instance exits within
  // milliseconds, and treating that as "the human is finished" would verify
  // a profile nobody had signed into yet.
  const launchedAt = Date.now();
  const quitDeliberately = new Promise<void>((done) => {
    child.once('exit', () => {
      if (Date.now() - launchedAt >= MIN_MANUAL_SESSION_MS) done();
      else console.log('(Chrome exited immediately — press Enter here when you are done.)');
    });
  });
  child.once('error', (err) => console.error(`Chrome failed to launch: ${err.message}`));

  console.log('1. Sign in to Google in that window (and X, if it needs it).');
  console.log('2. Quit Chrome entirely — Cmd-Q, not just closing the tab.');
  console.log('3. Verification starts by itself once Chrome exits.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Whichever happens first: Chrome exits, or you say you are done. The
    // Enter fallback matters because a Chrome that hands off to an already
    // running instance can exit immediately, before any sign-in happened.
    await Promise.race([
      quitDeliberately,
      rl.question('…or press Enter here once you have signed in and quit Chrome: '),
    ]);
  } finally {
    rl.close();
  }

  console.log('\nVerifying…');
  const ready = await verifyAfterRelease();
  console.log(
    ready
      ? `\nLOGIN OK — ${paths.profileDir} is ready for headed batches.`
      : '\nNOT READY — the session did not stick. Re-run `npm run login -- --manual`.',
  );
  process.exitCode = ready ? 0 : 1;
}

/** The Browserbase branch: Context provisioning, Live View sign-in, and
 * verification across a close/reopen boundary. See browserbaseLogin.ts. */
async function runBrowserbase(): Promise<void> {
  if (manual) {
    console.error(
      '\n--manual launches a local Chrome on a local profile, which does nothing for a ' +
        'Browserbase session. Run `npm run login` — it hands you a Live View to sign in ' +
        'through, which is the only way into a remote browser.',
    );
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    console.log('Verifying login state on the configured Browserbase context…');
    const statuses = await checkProfileLogins({
      profileDir: paths.profileDir,
      services: HEADED_LANE_SERVICES,
      headless: true,
      onStatus: (status) => {
        console.log(`  ${status.service.name}: ${formatLoginState(status.state)}`);
      },
    });
    const ready = allLoggedIn(statuses);
    console.log(
      ready
        ? '\nLOGIN OK — the Browserbase context is ready for authenticated batches.'
        : '\nNOT READY — run `npm run login` to sign in through Live View.',
    );
    process.exitCode = ready ? 0 : 1;
    return;
  }

  const ready = await runBrowserbaseLogin({
    services: HEADED_LANE_SERVICES,
    envFilePath,
  });
  console.log(
    ready
      ? '\nLOGIN OK — the logins survived closing and reopening the context, which is what ' +
          'an authenticated trial will do.'
      : '\nNOT READY — the logins did not survive the session boundary. Re-run ' +
          '`npm run login`. If a sign-in page refuses the cloud browser outright, that is ' +
          'the POC answer: this account cannot be used from Browserbase without proxy or ' +
          'region configuration.',
  );
  process.exitCode = ready ? 0 : 1;
}

if (provider === 'browserbase') {
  // Caught here rather than left to crash: every failure this branch can hit
  // is a configuration one — no API key, no Context, a plan with no free
  // concurrent session — and each already carries the sentence that fixes it.
  // A stack trace on top only hides that sentence.
  await runBrowserbase().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else if (manual) {
  await runManual();
} else {
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
        : '\nNOT READY — run `npm run login` to log in, or `npm run login -- --manual` ' +
          'if a sign-in page refuses the automated browser (Google always does).');
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
          console.log(
            'Fix the failing login in the Chrome window, then verify again. ' +
              'If the page says the browser may not be secure, quit and use ' +
              '`npm run login -- --manual`.',
          );
        }
      } finally {
        rl.close();
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}
