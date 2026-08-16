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

export { resolveRealChromePath } from '../browser/localChromeExecutable.js';

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
