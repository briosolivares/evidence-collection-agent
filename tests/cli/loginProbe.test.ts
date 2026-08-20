import { describe, expect, it } from 'vitest';

import {
  GOOGLE_SHEETS,
  X_HOME,
  allLoggedIn,
  formatLoginState,
  loginServicesForIds,
  settleProbe,
} from '../../src/cli/loginProbe.js';

describe('GOOGLE_SHEETS.classify', () => {
  it('reads an accounts.google.com redirect as logged out', () => {
    expect(
      GOOGLE_SHEETS.classify(
        'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fu%2F0%2F&flowName=GlifWebSignIn',
      ),
    ).toBe('logged-out');
    expect(GOOGLE_SHEETS.classify('https://accounts.google.com/ServiceLogin')).toBe('logged-out');
  });

  it('reads a surviving Sheets page as logged in', () => {
    expect(GOOGLE_SHEETS.classify('https://docs.google.com/spreadsheets/u/0/')).toBe('logged-in');
    expect(GOOGLE_SHEETS.classify('https://docs.google.com/spreadsheets/u/0/?tgif=d')).toBe('logged-in');
  });

  it('reports anything else — including unparseable URLs — as pending', () => {
    expect(GOOGLE_SHEETS.classify('about:blank')).toBe('pending');
    expect(GOOGLE_SHEETS.classify('https://workspace.google.com/products/sheets/')).toBe('pending');
    expect(GOOGLE_SHEETS.classify('not a url')).toBe('pending');
  });
});

describe('X_HOME.classify', () => {
  it('reads the login flow as logged out, on x.com and twitter.com alike', () => {
    expect(X_HOME.classify('https://x.com/i/flow/login?redirect_after_login=%2Fhome')).toBe('logged-out');
    expect(X_HOME.classify('https://twitter.com/login')).toBe('logged-out');
  });

  it('reads a surviving /home as logged in', () => {
    expect(X_HOME.classify('https://x.com/home')).toBe('logged-in');
    expect(X_HOME.classify('https://www.x.com/home')).toBe('logged-in');
  });

  it('reads the root landing page as logged out — /home bounces there when signed out', () => {
    expect(X_HOME.classify('https://x.com/')).toBe('logged-out');
    expect(X_HOME.classify('https://www.x.com')).toBe('logged-out');
  });

  it('reports foreign hosts and unrecognizable destinations as pending', () => {
    expect(X_HOME.classify('https://example.com/home')).toBe('pending');
    expect(X_HOME.classify('about:blank')).toBe('pending');
  });
});

describe('settleProbe', () => {
  const instantSleep = async (): Promise<void> => {};

  it('polls through pending states until a verdict appears, then confirms it', async () => {
    const urls = ['about:blank', 'about:blank', 'https://x.com/home', 'https://x.com/home'];
    let reads = 0;
    const state = await settleProbe(X_HOME, () => urls[Math.min(reads++, urls.length - 1)]!, instantSleep);
    expect(state).toBe('logged-in');
  });

  it('the confirmation re-check catches a late client-side redirect to the login flow', async () => {
    // x.com/home classifies logged-in on first read, then the page's own
    // JS bounces a signed-out session to the login flow.
    const urls = ['https://x.com/home', 'https://x.com/i/flow/login?redirect_after_login=%2Fhome'];
    let reads = 0;
    const state = await settleProbe(X_HOME, () => urls[Math.min(reads++, urls.length - 1)]!, instantSleep);
    expect(state).toBe('logged-out');
  });

  it('keeps the first verdict when the confirmation read is pending mid-navigation', async () => {
    const urls = ['https://accounts.google.com/ServiceLogin', 'about:blank'];
    let reads = 0;
    const state = await settleProbe(GOOGLE_SHEETS, () => urls[Math.min(reads++, urls.length - 1)]!, instantSleep);
    expect(state).toBe('logged-out');
  });

  it('catches a late bounce to the root landing page — the measured false positive', async () => {
    // Exactly what a Browserbase context with no X cookies did: /home first,
    // then the signed-out marketing page. This reported LOGGED IN before the
    // classifier learned that `/` means signed out.
    const urls = ['https://x.com/home', 'https://x.com/'];
    let reads = 0;
    const state = await settleProbe(X_HOME, () => urls[Math.min(reads++, urls.length - 1)]!, instantSleep);
    expect(state).toBe('logged-out');
  });

  it('downgrades an unconfirmed logged-in verdict to pending instead of trusting it', async () => {
    // A first read of logged-in is the one most likely to be wrong, because a
    // signed-out page sits on the signed-in destination until its JS runs. If
    // the confirmation cannot label where it went, the gate must not pass.
    const urls = ['https://x.com/home', 'https://x.com/i/some-interstitial'];
    let reads = 0;
    const state = await settleProbe(X_HOME, () => urls[Math.min(reads++, urls.length - 1)]!, instantSleep);
    expect(state).toBe('pending');
  });

  it('returns pending when the page never reaches a recognizable destination', async () => {
    const state = await settleProbe(GOOGLE_SHEETS, () => 'about:blank', instantSleep, {
      timeoutMs: 1_000,
    });
    expect(state).toBe('pending');
  });
});

describe('loginServicesForIds', () => {
  it('resolves ids to probes in declaration order, deduplicated', () => {
    expect(loginServicesForIds(['x', 'google-sheets', 'x']).map((s) => s.id)).toEqual([
      'google-sheets',
      'x',
    ]);
  });

  it('returns nothing for an empty requirement list', () => {
    expect(loginServicesForIds([])).toEqual([]);
  });

  // A typo must not become "no login required" — that turns the gate into a
  // rubber stamp for exactly the batch it was added to stop.
  it('throws on an unknown id rather than silently dropping the requirement', () => {
    expect(() => loginServicesForIds(['gogle-sheets'])).toThrow(/unknown login service/);
    expect(() => loginServicesForIds(['gogle-sheets'])).toThrow(/google-sheets, x/);
  });
});

describe('allLoggedIn', () => {
  it('is true only when every probed service is signed in', () => {
    expect(allLoggedIn([{ service: X_HOME, state: 'logged-in' }])).toBe(true);
    expect(allLoggedIn([])).toBe(true);
    expect(
      allLoggedIn([
        { service: X_HOME, state: 'logged-in' },
        { service: GOOGLE_SHEETS, state: 'logged-out' },
      ]),
    ).toBe(false);
  });

  it('treats an unverified probe as not ready', () => {
    expect(allLoggedIn([{ service: GOOGLE_SHEETS, state: 'pending' }])).toBe(false);
  });
});

describe('formatLoginState', () => {
  it('labels each verdict distinguishably', () => {
    expect(formatLoginState('logged-in')).toBe('LOGGED IN');
    expect(formatLoginState('logged-out')).toBe('NOT LOGGED IN');
    expect(formatLoginState('pending')).toContain('UNVERIFIED');
  });
});
