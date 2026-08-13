import { describe, expect, it } from 'vitest';

import { GOOGLE_SHEETS, X_HOME, settleProbe } from './loginProbe.js';

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

  it('reports the landing page and foreign hosts as pending', () => {
    expect(X_HOME.classify('https://x.com/')).toBe('pending');
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

  it('returns pending when the page never reaches a recognizable destination', async () => {
    const state = await settleProbe(GOOGLE_SHEETS, () => 'about:blank', instantSleep, {
      timeoutMs: 1_000,
    });
    expect(state).toBe('pending');
  });
});
