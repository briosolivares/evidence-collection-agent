import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { BrowserSessionProvider } from '../../src/browser/sessionProvider.js';
import {
  ATTACHED_CHROME_ENDPOINT_ENV_VAR,
  ATTACHED_CHROME_SETUP_URL,
  attachedChromeEndpoint,
  AttachedChromeSetupBrowserSessionProvider,
  defaultChromeUserDataDir,
  discoverAttachedChromeEndpoint,
} from '../../src/browser/attachedChromeSetup.js';

const DISCOVERED_ENDPOINT =
  'ws://127.0.0.1:61545/devtools/browser/private-discovery-token';
const controller = {} as BrowserController;

function providerReturning(value: BrowserController = controller): BrowserSessionProvider {
  return { createSession: vi.fn(async () => value) };
}

describe('attached Chrome configuration and discovery', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reads only the explicit endpoint variable and trims it', () => {
    expect(attachedChromeEndpoint({})).toBeUndefined();
    expect(attachedChromeEndpoint({ [ATTACHED_CHROME_ENDPOINT_ENV_VAR]: '   ' }))
      .toBeUndefined();
    expect(
      attachedChromeEndpoint({
        [ATTACHED_CHROME_ENDPOINT_ENV_VAR]: '  http://127.0.0.1:9222  ',
      }),
    ).toBe('http://127.0.0.1:9222');
  });

  it('matches Chrome stable default-profile discovery on supported platforms', () => {
    expect(defaultChromeUserDataDir({ platform: 'darwin', home: '/Users/test' })).toBe(
      '/Users/test/Library/Application Support/Google/Chrome',
    );
    expect(defaultChromeUserDataDir({ platform: 'linux', home: '/home/test' })).toBe(
      '/home/test/.config/google-chrome',
    );
    expect(
      defaultChromeUserDataDir({
        platform: 'win32',
        home: 'C:\\Users\\test',
        localAppData: 'C:\\Users\\test\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data');
    expect(defaultChromeUserDataDir({ platform: 'aix', home: '/home/test' }))
      .toBeUndefined();
  });

  it('reads a bounded DevToolsActivePort record and rejects malformed state', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sherlock-attached-discovery-'));
    const reachable = vi.fn(async () => true);
    expect(await discoverAttachedChromeEndpoint(tempDir, reachable)).toBeUndefined();

    await writeFile(
      join(tempDir, 'DevToolsActivePort'),
      '61545\n/devtools/browser/private-discovery-token\n',
    );
    expect(await discoverAttachedChromeEndpoint(tempDir, reachable)).toBe(DISCOVERED_ENDPOINT);
    expect(reachable).toHaveBeenCalledWith(61_545);

    expect(
      await discoverAttachedChromeEndpoint(tempDir, async () => false),
    ).toBeUndefined();

    await writeFile(join(tempDir, 'DevToolsActivePort'), 'not-a-port\nsecret\n');
    expect(await discoverAttachedChromeEndpoint(tempDir, reachable)).toBeUndefined();

    await writeFile(join(tempDir, 'DevToolsActivePort'), 'x'.repeat(4_097));
    await expect(discoverAttachedChromeEndpoint(tempDir, reachable)).rejects.toThrow(
      'Chrome remote-debugging discovery state is invalid.',
    );
  });
});

describe('AttachedChromeSetupBrowserSessionProvider', () => {
  it('probes a configured endpoint first and performs no discovery on success', async () => {
    const explicitProvider = providerReturning();
    const createAttachedProvider = vi.fn(() => explicitProvider);
    const discoverEndpoint = vi.fn(async () => DISCOVERED_ENDPOINT);
    const openSetupPage = vi.fn(async () => undefined);
    const onSetupState = vi.fn();
    const provider = new AttachedChromeSetupBrowserSessionProvider({
      explicitEndpoint: 'http://127.0.0.1:9222',
      onSetupState,
      createAttachedProvider,
      discoverEndpoint,
      openSetupPage,
    });

    await expect(provider.createSession()).resolves.toBe(controller);
    expect(createAttachedProvider).toHaveBeenCalledTimes(1);
    expect(discoverEndpoint).not.toHaveBeenCalled();
    expect(openSetupPage).not.toHaveBeenCalled();
    expect(onSetupState).not.toHaveBeenCalled();
  });

  it('falls back from an unavailable explicit endpoint to local discovery', async () => {
    const explicit = {
      createSession: vi.fn(async () => {
        throw new Error('failed http://127.0.0.1:9222/private');
      }),
    } satisfies BrowserSessionProvider;
    const discovered = providerReturning();
    const createAttachedProvider = vi
      .fn()
      .mockReturnValueOnce(explicit)
      .mockReturnValueOnce(discovered);
    const states: string[] = [];
    const provider = new AttachedChromeSetupBrowserSessionProvider({
      explicitEndpoint: 'http://127.0.0.1:9222/private',
      onSetupState: (state) => states.push(state),
      createAttachedProvider,
      discoverEndpoint: async () => DISCOVERED_ENDPOINT,
      openSetupPage: async () => undefined,
    });

    await expect(provider.createSession()).resolves.toBe(controller);
    expect(createAttachedProvider).toHaveBeenCalledTimes(2);
    expect(states.join('\n')).not.toContain('9222');
    expect(states.join('\n')).not.toContain('private-discovery-token');
  });

  it('opens Chrome setup, waits boundedly for the user, then attaches once', async () => {
    const discoveries = [undefined, undefined, DISCOVERED_ENDPOINT];
    const openSetupPage = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const attached = providerReturning();
    const states: string[] = [];
    const provider = new AttachedChromeSetupBrowserSessionProvider({
      onSetupState: (state) => states.push(state),
      discoverEndpoint: vi.fn(async () => discoveries.shift()),
      openSetupPage,
      createAttachedProvider: vi.fn(() => attached),
      wait,
    });

    await expect(provider.createSession()).resolves.toBe(controller);
    expect(openSetupPage).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(states).toContain(`Opening ${ATTACHED_CHROME_SETUP_URL} in Chrome.`);
    expect(states.join('\n')).toContain(
      'Allow remote debugging for this browser instance',
    );
    expect(states.join('\n')).not.toContain('private-discovery-token');
  });

  it('times out without polling forever and reports only actionable setup text', async () => {
    let now = 10_000;
    const openSetupPage = vi.fn(async () => undefined);
    const discoverEndpoint = vi.fn(async () => undefined);
    const provider = new AttachedChromeSetupBrowserSessionProvider({
      onSetupState: () => undefined,
      setupTimeoutMs: 500,
      connectionTimeoutMs: 100,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      discoverEndpoint,
      openSetupPage,
    });

    await expect(provider.createSession()).rejects.toThrow(
      /Timed out waiting for Chrome remote debugging/,
    );
    expect(openSetupPage).toHaveBeenCalledOnce();
    expect(discoverEndpoint.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('redacts a discovered endpoint from connection failures and errors', async () => {
    const createAttachedProvider = vi.fn(() => ({
      createSession: async () => {
        throw new Error(`connection failed at ${DISCOVERED_ENDPOINT}`);
      },
    }));
    const states: string[] = [];
    const provider = new AttachedChromeSetupBrowserSessionProvider({
      onSetupState: (state) => states.push(state),
      discoverEndpoint: async () => DISCOVERED_ENDPOINT,
      createAttachedProvider,
    });

    let message = '';
    try {
      await provider.createSession();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('could not attach');
    expect(message).not.toContain(DISCOVERED_ENDPOINT);
    expect(states.join('\n')).not.toContain(DISCOVERED_ENDPOINT);
  });

  it('rejects an unsafe explicit endpoint before discovery or setup effects', () => {
    const discoverEndpoint = vi.fn(async () => DISCOVERED_ENDPOINT);
    const openSetupPage = vi.fn(async () => undefined);

    expect(
      () =>
        new AttachedChromeSetupBrowserSessionProvider({
          explicitEndpoint: 'http://attacker.example:9222/private',
          onSetupState: () => undefined,
          discoverEndpoint,
          openSetupPage,
        }),
    ).toThrow(/valid loopback/);
    expect(discoverEndpoint).not.toHaveBeenCalled();
    expect(openSetupPage).not.toHaveBeenCalled();
  });
});
