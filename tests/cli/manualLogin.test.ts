import { describe, expect, it } from 'vitest';

import {
  MANUAL_LOGIN_START_URL,
  manualLoginArgs,
  resolveRealChromePath,
} from '../../src/cli/manualLogin.js';

describe('resolveRealChromePath', () => {
  it('uses an explicit override verbatim, without probing the filesystem', () => {
    const never = () => {
      throw new Error('should not probe when overridden');
    };
    expect(resolveRealChromePath('/opt/my-chrome', 'linux', never)).toBe('/opt/my-chrome');
  });

  it('treats an empty override as absent', () => {
    expect(resolveRealChromePath('', 'darwin', () => true)).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  });

  it('prefers real Chrome over Chromium when both exist', () => {
    expect(resolveRealChromePath(undefined, 'darwin', () => true)).toContain('Google Chrome');
  });

  it('falls through to the next candidate when the preferred one is missing', () => {
    const onlyChromium = (path: string) => path.includes('Chromium');
    expect(resolveRealChromePath(undefined, 'darwin', onlyChromium)).toContain('Chromium');
  });

  it('returns undefined when nothing is found or the platform is unknown', () => {
    expect(resolveRealChromePath(undefined, 'darwin', () => false)).toBeUndefined();
    expect(resolveRealChromePath(undefined, 'sunos', () => true)).toBeUndefined();
  });
});

describe('manualLoginArgs', () => {
  it('aims the launch at the eval profile and lands on the sign-in page', () => {
    const args = manualLoginArgs('/repo/chrome-profile', MANUAL_LOGIN_START_URL);
    expect(args).toContain('--user-data-dir=/repo/chrome-profile');
    expect(args.at(-1)).toBe(MANUAL_LOGIN_START_URL);
  });

  // The entire point of this launch is to look like a person's own browser.
  // Any automation hint reintroduces the block it exists to get around.
  it('passes no flag that marks the browser as automated', () => {
    const args = manualLoginArgs('/repo/chrome-profile', MANUAL_LOGIN_START_URL);
    for (const forbidden of ['--enable-automation', '--remote-debugging-port', '--headless']) {
      expect(args.some((arg) => arg.startsWith(forbidden))).toBe(false);
    }
  });

  it('continues to Sheets, the page the probe classifies', () => {
    expect(MANUAL_LOGIN_START_URL).toContain('docs.google.com/spreadsheets');
  });
});
