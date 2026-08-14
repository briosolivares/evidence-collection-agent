// Sign in to the headed-lane profile using a plain, un-automated Chrome.
//
// Google refuses its sign-in flow outright in a browser it identifies as
// automated ("Couldn't sign you in — This browser or app may not be
// secure"), and Playwright's launch is unmistakably automated: it passes
// --enable-automation and opens a remote-debugging port. No flag
// combination reliably talks Google out of that, so the interactive
// `npm run login` path cannot be the one that types the password.
//
// The session, though, is just cookies in the profile directory. So sign
// in with an ordinary Chrome pointed at that same --user-data-dir, quit
// it, and every later automated launch inherits a session Google already
// trusts. It is the sign-in *flow* that is blocked, not the cookie.
//
// This module resolves the binary and builds the argv; `login.ts` spawns
// it and owns the terminal.

import { existsSync } from 'node:fs';

/** Where a real Chrome lives, per platform, when nothing overrides it.
 * Ordered most- to least-preferred; the first that exists wins. */
const DEFAULT_CHROME_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * Locate a Chrome binary to launch by hand.
 *
 * Deliberately NOT Playwright's bundled browser: this launch exists to be
 * indistinguishable from a human's own Chrome, and a downloaded Chromium
 * build is one of the things Google's sign-in checks notice.
 *
 * @param override - an explicit path (SHERLOCK_CHROME_PATH), used as-is
 * @param platform - process.platform
 * @param exists - existence probe, injected for tests
 * @returns the binary path, or undefined when none of the known
 *   locations holds one
 */
export function resolveRealChromePath(
  override: string | undefined,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (override !== undefined && override !== '') return override;
  return (DEFAULT_CHROME_PATHS[platform] ?? []).find((candidate) => exists(candidate));
}

/**
 * Argv for the manual sign-in launch.
 *
 * Every flag here is either required or a first-run annoyance suppressor —
 * nothing that hints at automation. `--user-data-dir` is the whole point:
 * it aims the session at the profile the eval trials launch, so a login
 * that succeeds lands where the trials will look for it.
 */
export function manualLoginArgs(profileDir: string, startUrl: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    startUrl,
  ];
}

/** Where to land the manual sign-in. Google's own account chooser, with
 * Sheets as the continue target, so a successful sign-in ends on the page
 * the probe classifies. */
export const MANUAL_LOGIN_START_URL =
  'https://accounts.google.com/AccountChooser?continue=https://docs.google.com/spreadsheets/u/0/';
