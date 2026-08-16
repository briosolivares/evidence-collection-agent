import { existsSync } from 'node:fs';

/** Where a real, user-facing Chrome lives on each supported platform. */
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
 * Locate a real Chrome binary, never Playwright's bundled test browser.
 *
 * Both manual login and attached-browser setup need the user's ordinary
 * browser: the former writes authentication into a user-selected profile,
 * while the latter asks the already-running daily browser to expose its
 * explicitly enabled debugging endpoint.
 */
export function resolveRealChromePath(
  override: string | undefined,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (override !== undefined && override !== '') return override;
  return (DEFAULT_CHROME_PATHS[platform] ?? []).find((candidate) => exists(candidate));
}
