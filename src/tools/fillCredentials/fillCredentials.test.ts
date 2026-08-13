import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileCredentialStore, type CredentialStore } from '../../auth/credentialStore.js';
import {
  BrowserRefNotFoundError,
  type BrowserController,
} from '../../browser/controller.js';
import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolCtx } from '../registry.js';
import { fillCredentialsTool } from './fillCredentials.js';

const SECRET = 'unit-secret-pass-4c1d';

function fakeBrowser(url = 'https://mobile.x.com/login'): {
  browser: BrowserController;
  typed: Array<{ ref: string; text: string }>;
  clicked: string[];
} {
  const typed: Array<{ ref: string; text: string }> = [];
  const clicked: string[] = [];
  const browser = {
    currentUrl: () => url,
    type: async (ref: string, text: string) => {
      typed.push({ ref, text });
    },
    click: async (ref: string) => {
      clicked.push(ref);
    },
  } as unknown as BrowserController;
  return { browser, typed, clicked };
}

function fakeStore(): { store: CredentialStore; lookups: string[] } {
  const lookups: string[] = [];
  const store: CredentialStore = {
    listHosts: async () => ['x.com'],
    lookup: async (hostname) => {
      lookups.push(hostname);
      return hostname.endsWith('x.com')
        ? { username: 'test-account', password: SECRET }
        : null;
    },
  };
  return { store, lookups };
}

function call(ctx: ToolCtx, input: unknown) {
  const registry = createRegistry([fillCredentialsTool as never]);
  return executeToolCall(
    registry,
    { id: 'fill-1', name: 'fill_credentials', input },
    ctx,
  );
}

describe('fill_credentials tool (unit)', () => {
  it('types the right stored values into the right refs, then submits', async () => {
    const { browser, typed, clicked } = fakeBrowser();
    const { store } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      {
        fields: [
          { ref: 'e1', value: 'username' },
          { ref: 'e2', value: 'password' },
        ],
        submit_ref: 'e3',
      },
    );

    expect(result.isError).toBe(false);
    expect(typed).toEqual([
      { ref: 'e1', text: 'test-account' },
      { ref: 'e2', text: SECRET },
    ]);
    expect(clicked).toEqual(['e3']);
    expect(JSON.parse(result.content)).toEqual({
      filled: ['username', 'password'],
      submitted: true,
      url: 'https://mobile.x.com/login',
    });
  });

  it('derives the hostname from the browser, never from input', async () => {
    const { browser } = fakeBrowser('https://mobile.x.com/i/flow/login?x=1');
    const { store, lookups } = fakeStore();

    await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      { fields: [{ ref: 'e1', value: 'username' }] },
    );

    expect(lookups).toEqual(['mobile.x.com']);
  });

  it('reports the documented error when no credentials exist for the site', async () => {
    const { browser, typed } = fakeBrowser('https://unknown-site.example/login');
    const { store } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      { fields: [{ ref: 'e1', value: 'username' }] },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain(
      'No credentials stored for "unknown-site.example". ' +
        'Ask the user to complete login manually.',
    );
    expect(typed).toEqual([]);
  });

  it('treats a context without a credential store as an empty store', async () => {
    const { browser, typed } = fakeBrowser();

    const result = await call(
      { runDir: '/tmp/unused', browser },
      { fields: [{ ref: 'e1', value: 'username' }] },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('No credentials stored for "mobile.x.com"');
    expect(typed).toEqual([]);
  });

  it('rejects a password fill without submit_ref at the schema', async () => {
    const { browser, typed } = fakeBrowser();
    const { store, lookups } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      { fields: [{ ref: 'e2', value: 'password' }] },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(result.content).toContain('submit_ref');
    // Rejected before execute: nothing was looked up or typed.
    expect(lookups).toEqual([]);
    expect(typed).toEqual([]);
  });

  it('rejects duplicate value kinds at the schema', async () => {
    const { browser } = fakeBrowser();
    const { store } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      {
        fields: [
          { ref: 'e1', value: 'username' },
          { ref: 'e2', value: 'username' },
        ],
      },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(result.content).toContain('at most once');
  });

  it('allows a username-only fill without submitting', async () => {
    const { browser, typed, clicked } = fakeBrowser();
    const { store } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      { fields: [{ ref: 'e1', value: 'username' }] },
    );

    expect(result.isError).toBe(false);
    expect(typed).toEqual([{ ref: 'e1', text: 'test-account' }]);
    expect(clicked).toEqual([]);
    expect(JSON.parse(result.content)).toMatchObject({ submitted: false });
  });

  it('never places secret material in the result', async () => {
    const { browser } = fakeBrowser();
    const { store } = fakeStore();

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      {
        fields: [
          { ref: 'e1', value: 'username' },
          { ref: 'e2', value: 'password' },
        ],
        submit_ref: 'e3',
      },
    );

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('turns a stale ref into the standard reinspect guidance', async () => {
    const { store } = fakeStore();
    const browser = {
      currentUrl: () => 'https://x.com/login',
      type: vi.fn().mockRejectedValue(new BrowserRefNotFoundError('e9')),
    } as unknown as BrowserController;

    const result = await call(
      { runDir: '/tmp/unused', browser, credentials: store },
      { fields: [{ ref: 'e9', value: 'username' }] },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('inspect_page');
    expect(result.content).not.toContain(SECRET);
  });
});

describe('fill_credentials tool (integration)', () => {
  const suite = setupBrowserToolSuite('fill-credentials');
  const registry = createRegistry([
    ...observationTools,
    fillCredentialsTool as never,
  ]);

  let credentialsDir: string;
  let store: FileCredentialStore;
  const password = 'fixture-pass-8d1x';

  beforeAll(async () => {
    credentialsDir = await mkdtemp(join(tmpdir(), 'fill-credentials-store-'));
    const filePath = join(credentialsDir, '.credentials.json');
    await writeFile(
      filePath,
      JSON.stringify({
        '127.0.0.1': { username: 'fixture-user', password },
      }),
      { mode: 0o600 },
    );
    store = new FileCredentialStore(filePath);
  });

  afterAll(async () => {
    await rm(credentialsDir, { recursive: true, force: true });
  });

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller(), credentials: store },
    );
  }

  it(
    'completes the two-step login fixture with the stored credentials',
    async () => {
      await call('navigate', { url: suite.server().url('/login.html') });

      const stepOne = await call('inspect_page', {});
      expect(stepOne.isError).toBe(false);
      const usernameRef = refFor(stepOne.content, 'textbox "Username"');
      const nextRef = refFor(stepOne.content, 'button "Next"');

      const filledUsername = await call('fill_credentials', {
        fields: [{ ref: usernameRef, value: 'username' }],
      });
      expect(filledUsername.isError).toBe(false);
      expect(JSON.parse(filledUsername.content)).toMatchObject({
        filled: ['username'],
        submitted: false,
      });

      await suite.controller().click(nextRef);

      const stepTwo = await call('inspect_page', {});
      expect(stepTwo.isError).toBe(false);
      const passwordRef = refFor(stepTwo.content, 'textbox "Password"');
      const submitRef = refFor(stepTwo.content, 'button "Log in"');

      const submitted = await call('fill_credentials', {
        fields: [{ ref: passwordRef, value: 'password' }],
        submit_ref: submitRef,
      });
      expect(submitted.isError).toBe(false);
      expect(JSON.parse(submitted.content)).toMatchObject({
        filled: ['password'],
        submitted: true,
      });

      // The fixture recorded exactly what the browser submitted.
      expect(suite.server().lastLogin()).toEqual({
        username: 'fixture-user',
        password,
      });

      const landing = await call('inspect_page', {});
      expect(landing.content).toContain('Login successful');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
