import { describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { LocalChromeBrowserSessionOptions } from '../../src/browser/playwrightBrowserController.js';
import { createEvalBrowserRuntime } from './browserRuntime.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeBrowser(name: string, events: string[]): BrowserController {
  return {
    close: vi.fn(async () => {
      events.push(`close:${name}`);
    }),
  } as unknown as BrowserController;
}

describe('createEvalBrowserRuntime', () => {
  it('gives every normal trial a unique headless profile and removes it after close', async () => {
    const events: string[] = [];
    const providerOptions: LocalChromeBrowserSessionOptions[] = [];
    let profile = 0;
    const runtime = createEvalBrowserRuntime({
      authenticatedProfileDir: '/persistent/auth-profile',
      createTempProfile: async () => `/tmp/eval-profile-${++profile}`,
      createProvider: (options) => {
        providerOptions.push(options);
        const browser = fakeBrowser(options.profileDir, events);
        return {
          createSession: async () => {
            events.push(`create:${options.profileDir}`);
            return browser;
          },
        };
      },
      removeTempProfile: async (path) => {
        events.push(`remove:${path}`);
      },
    });

    await Promise.all([
      runtime.withBrowser(false, async () => 'one'),
      runtime.withBrowser(false, async () => 'two'),
    ]);
    await runtime.close();

    expect(providerOptions).toEqual([
      { profileDir: '/tmp/eval-profile-1', headless: true },
      { profileDir: '/tmp/eval-profile-2', headless: true },
    ]);
    for (const path of ['/tmp/eval-profile-1', '/tmp/eval-profile-2']) {
      expect(events.indexOf(`close:${path}`)).toBeLessThan(events.indexOf(`remove:${path}`));
    }
  });

  it('reuses one headed authenticated session and serializes its operations', async () => {
    const events: string[] = [];
    const providerOptions: LocalChromeBrowserSessionOptions[] = [];
    const firstCanFinish = deferred();
    const runtime = createEvalBrowserRuntime({
      authenticatedProfileDir: '/persistent/auth-profile',
      createProvider: (options) => {
        providerOptions.push(options);
        return { createSession: async () => fakeBrowser('auth', events) };
      },
      createTempProfile: async () => {
        throw new Error('normal profile should not be created');
      },
      removeTempProfile: async () => {
        throw new Error('persistent profile must not be removed');
      },
    });

    const first = runtime.withBrowser(true, async () => {
      events.push('first:start');
      await firstCanFinish.promise;
      events.push('first:end');
    });
    const second = runtime.withBrowser(true, async () => {
      events.push('second:start');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstCanFinish.resolve();
    await Promise.all([first, second]);
    await runtime.close();
    await runtime.close();

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'close:auth']);
    expect(providerOptions).toEqual([
      { profileDir: '/persistent/auth-profile', headless: false },
    ]);
  });

  it('preserves the trial error while warning about cleanup failures', async () => {
    const warnings: string[] = [];
    const runtime = createEvalBrowserRuntime({
      authenticatedProfileDir: '/persistent/auth-profile',
      createTempProfile: async () => '/tmp/failing-profile',
      createProvider: () => ({
        createSession: async () =>
          ({
            close: async () => {
              throw new Error('close failed');
            },
          }) as unknown as BrowserController,
      }),
      removeTempProfile: async () => {
        throw new Error('remove failed');
      },
      onWarning: (message) => warnings.push(message),
    });

    await expect(
      runtime.withBrowser(false, async () => {
        throw new Error('trial failed');
      }),
    ).rejects.toThrow('trial failed');

    expect(warnings).toEqual([
      expect.stringContaining('/tmp/failing-profile: remove failed'),
      expect.stringContaining('/tmp/failing-profile: close failed'),
    ]);
  });

  it('never launches the headed session when a batch has no authenticated jobs', async () => {
    const options: LocalChromeBrowserSessionOptions[] = [];
    const runtime = createEvalBrowserRuntime({
      authenticatedProfileDir: '/persistent/auth-profile',
      createTempProfile: async () => '/tmp/normal-only',
      createProvider: (providerOptions) => {
        options.push(providerOptions);
        return { createSession: async () => fakeBrowser('normal', []) };
      },
      removeTempProfile: async () => undefined,
    });

    await runtime.withBrowser(false, async () => undefined);
    await runtime.close();

    expect(options).toEqual([{ profileDir: '/tmp/normal-only', headless: true }]);
    expect(() => runtime.withBrowser(false, async () => undefined)).toThrow(/closed/);
  });
});
