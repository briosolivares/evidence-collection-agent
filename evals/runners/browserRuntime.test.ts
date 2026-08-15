import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { LocalChromeBrowserSessionOptions } from '../../src/browser/playwrightBrowserController.js';
import { createBrowserbaseEvalBrowserAdapter, createEvalBrowserRuntime } from './browserRuntime.js';

/**
 * Keeps a test out of the orphaned-profile reaper. Without it the runtime
 * scans the real system temp directory on construction, which would make these
 * tests non-hermetic and let a developer's leftover profiles show up in their
 * warning and event assertions.
 */
const noReaping = async (): Promise<string[]> => [];

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

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
    // An empty env pins the local provider so a developer with
    // SHERLOCK_BROWSER_PROVIDER=browserbase exported in their shell cannot make
    // this hermetic suite reach the network.
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      listTempProfiles: noReaping,
      executablePath: '/opt/custom-chrome',
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
      {
        profileDir: '/tmp/eval-profile-1',
        headless: true,
        executablePath: '/opt/custom-chrome',
      },
      {
        profileDir: '/tmp/eval-profile-2',
        headless: true,
        executablePath: '/opt/custom-chrome',
      },
    ]);
    for (const path of ['/tmp/eval-profile-1', '/tmp/eval-profile-2']) {
      expect(events.indexOf(`close:${path}`)).toBeLessThan(events.indexOf(`remove:${path}`));
    }
  });

  it('reuses one headed authenticated session and serializes its operations', async () => {
    const events: string[] = [];
    const providerOptions: LocalChromeBrowserSessionOptions[] = [];
    const firstCanFinish = deferred();
    const firstStarted = deferred();
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      listTempProfiles: noReaping,
      executablePath: '/opt/custom-chrome',
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
      firstStarted.resolve();
      await firstCanFinish.promise;
      events.push('first:end');
    });
    const second = runtime.withBrowser(true, async () => {
      events.push('second:start');
    });
    await firstStarted.promise;
    expect(events).toEqual(['first:start']);

    firstCanFinish.resolve();
    await Promise.all([first, second]);
    await runtime.close();
    await runtime.close();

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'close:auth']);
    expect(providerOptions).toEqual([
      {
        profileDir: '/persistent/auth-profile',
        headless: false,
        executablePath: '/opt/custom-chrome',
      },
    ]);
  });

  it('preserves the trial error while warning about cleanup failures', async () => {
    const warnings: string[] = [];
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      listTempProfiles: noReaping,
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
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      listTempProfiles: noReaping,
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

  it('explains the persistent-profile singleton lock', async () => {
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      listTempProfiles: noReaping,
      createProvider: () => ({
        createSession: async () => {
          throw new Error('Failed to create a ProcessSingleton for your profile directory');
        },
      }),
    });

    await expect(runtime.withBrowser(true, async () => undefined)).rejects.toThrow(
      /authenticated Chrome profile is already in use.*close the other Sherlock/i,
    );
    await runtime.close();
  });
});

// Exercised against a real fixture directory rather than fakes: the whole point
// is that readdir/stat/rm behave as assumed on actual profile directories, and
// a mocked filesystem would have agreed with the buggy version too.
describe('createEvalBrowserRuntime orphaned-profile reaping', () => {
  let root: string;

  /**
   * Create a profile directory under the fixture root with a real mtime.
   *
   * @param name - directory name, prefixed or not
   * @param ageMs - how long ago it was last written; 0 means just now
   * @returns the directory's absolute path
   */
  async function profileDir(name: string, ageMs: number): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir);
    // Nested content proves removal is recursive, as a live Chrome profile is.
    await mkdir(join(dir, 'Default'));
    await writeFile(join(dir, 'Default', 'Cookies'), 'x');
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(dir, when, when);
    }
    return dir;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-reaper-fixture-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes profiles abandoned hours ago and spares live ones', async () => {
    const warnings: string[] = [];
    await profileDir('evidence-agent-eval-chrome-abandoned', FOUR_HOURS_MS + 60_000);
    await profileDir('evidence-agent-eval-chrome-live', 0);
    await profileDir('unrelated-tool-cache', FOUR_HOURS_MS + 60_000);
    await writeFile(join(root, 'evidence-agent-eval-chrome-notadir'), 'x');

    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      tempProfileRoot: root,
      onWarning: (message) => warnings.push(message),
    });
    await runtime.close();

    // A live trial's profile is touched continuously, so mtime is the guard
    // against reaping one out from under a concurrently running batch.
    expect((await readdir(root)).sort()).toEqual([
      'evidence-agent-eval-chrome-live',
      'evidence-agent-eval-chrome-notadir',
      'unrelated-tool-cache',
    ]);
    expect(warnings).toEqual([]);
  });

  it('leaves a profile alone right up to the staleness threshold', async () => {
    await profileDir('evidence-agent-eval-chrome-borderline', FOUR_HOURS_MS - 60_000);

    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      tempProfileRoot: root,
    });
    await runtime.close();

    expect(await readdir(root)).toEqual(['evidence-agent-eval-chrome-borderline']);
  });

  it('warns instead of failing the batch when the temp directory cannot be read', async () => {
    const warnings: string[] = [];
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      tempProfileRoot: join(root, 'does-not-exist'),
      onWarning: (message) => warnings.push(message),
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('could not scan for orphaned Chrome')]);
  });

  it('keeps sweeping after one removal fails, and warns per failure', async () => {
    const warnings: string[] = [];
    const attempted: string[] = [];
    const first = await profileDir('evidence-agent-eval-chrome-aaa', FOUR_HOURS_MS + 60_000);
    const second = await profileDir('evidence-agent-eval-chrome-bbb', FOUR_HOURS_MS + 60_000);

    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      tempProfileRoot: root,
      removeTempProfile: async (dir) => {
        attempted.push(dir);
        if (dir === first) throw new Error('EPERM');
      },
      onWarning: (message) => warnings.push(message),
    });
    await runtime.close();

    expect(attempted.sort()).toEqual([first, second].sort());
    expect(warnings).toEqual([
      expect.stringContaining(`could not remove orphaned Chrome profile ${first}: EPERM`),
    ]);
  });

  it('is complete by the time close() resolves', async () => {
    let removalFinished = false;
    await profileDir('evidence-agent-eval-chrome-slow', FOUR_HOURS_MS + 60_000);

    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: '/persistent/auth-profile',
      tempProfileRoot: root,
      removeTempProfile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        removalFinished = true;
      },
    });
    await runtime.close();

    expect(removalFinished).toBe(true);
  });
});

// The Browserbase adapter, exercised through its own `createProvider` test
// seam so no test here ever reaches the real Browserbase API or a real
// browser. `env: {}` on `createEvalBrowserRuntime` pins provider
// auto-selection off (see the top-of-file comment on `noReaping`'s sibling
// tests above); `createBrowserbaseEvalBrowserAdapter`'s OWN `env` is what
// carries `BROWSERBASE_API_KEY`/`BROWSERBASE_CONTEXT_ID`, since the adapter
// validates those itself, independently of runtime provider selection.
describe('createEvalBrowserRuntime on Browserbase', () => {
  const UNUSED_LOCAL_PROFILE_DIR = '/local-profile-unused-by-the-browserbase-adapter';

  function fakeBrowserbaseBrowser(sessionId: string, events: string[]): BrowserController {
    return {
      close: vi.fn(async () => {
        events.push(`close:${sessionId}`);
      }),
      sessionDiagnostics: { provider: 'browserbase', sessionId },
    } as unknown as BrowserController;
  }

  it('gives every isolated trial its own context-free, non-live-view session', async () => {
    const events: string[] = [];
    const configs: Array<{ contextId?: string; liveView: boolean; lane: string }> = [];
    let sessionCount = 0;
    const adapter = createBrowserbaseEvalBrowserAdapter({
      env: { BROWSERBASE_API_KEY: 'key' },
      createProvider: (config) => {
        configs.push(config);
        const sessionId = `session-${++sessionCount}`;
        return {
          createSession: async () => {
            events.push(`create:${sessionId}`);
            return fakeBrowserbaseBrowser(sessionId, events);
          },
        };
      },
    });
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: UNUSED_LOCAL_PROFILE_DIR,
      adapter,
    });

    await Promise.all([
      runtime.withBrowser(false, async () => 'one'),
      runtime.withBrowser(false, async () => 'two'),
    ]);
    await runtime.close();

    // Two isolated trials, two distinct sessions — a shared Context (or a
    // shared session) would let one trial's state reach the next, which is
    // exactly what isolation exists to prevent.
    expect(configs).toHaveLength(2);
    for (const config of configs) {
      expect(config.contextId).toBeUndefined();
      expect(config.liveView).toBe(false);
      expect(config.lane).toBe('isolated');
    }
    expect(events).toEqual(
      expect.arrayContaining([
        'create:session-1',
        'create:session-2',
        'close:session-1',
        'close:session-2',
      ]),
    );
  });

  it("closes an isolated trial's session when the trial throws, and the trial's own error propagates rather than the close failure", async () => {
    const warnings: string[] = [];
    const adapter = createBrowserbaseEvalBrowserAdapter({
      env: { BROWSERBASE_API_KEY: 'key' },
      createProvider: () => ({
        createSession: async () =>
          ({
            close: async () => {
              throw new Error('close failed');
            },
            sessionDiagnostics: { provider: 'browserbase', sessionId: 'sess-1' },
          }) as unknown as BrowserController,
      }),
    });
    // The "could not close" warning is emitted by the lane policy in
    // `createEvalBrowserRuntime` (it wraps `lease.release()`), not by the
    // adapter itself — so it is `onWarning` here, on the runtime, that
    // receives it, not the adapter factory's own `onWarning`.
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: UNUSED_LOCAL_PROFILE_DIR,
      adapter,
      onWarning: (message) => warnings.push(message),
    });

    await expect(
      runtime.withBrowser(false, async () => {
        throw new Error('trial failed');
      }),
    ).rejects.toThrow('trial failed');

    expect(warnings).toEqual([expect.stringContaining('sess-1: close failed')]);
    await runtime.close();
  });

  it('reuses one authenticated session, serializes its operations, opens it against the configured context, and closes it idempotently', async () => {
    const events: string[] = [];
    const configs: Array<{ contextId?: string; liveView: boolean; lane: string }> = [];
    const firstCanFinish = deferred();
    const firstStarted = deferred();
    const adapter = createBrowserbaseEvalBrowserAdapter({
      env: { BROWSERBASE_API_KEY: 'key', BROWSERBASE_CONTEXT_ID: 'ctx-auth' },
      createProvider: (config) => {
        configs.push(config);
        return { createSession: async () => fakeBrowserbaseBrowser('auth-session', events) };
      },
    });
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: UNUSED_LOCAL_PROFILE_DIR,
      adapter,
    });

    const first = runtime.withBrowser(true, async () => {
      events.push('first:start');
      firstStarted.resolve();
      await firstCanFinish.promise;
      events.push('first:end');
    });
    const second = runtime.withBrowser(true, async () => {
      events.push('second:start');
    });
    await firstStarted.promise;
    // The second operation must not begin until the first has finished —
    // simultaneous sessions against the same Context would race over the
    // same stored cookies.
    expect(events).toEqual(['first:start']);

    firstCanFinish.resolve();
    await Promise.all([first, second]);
    await runtime.close();
    await runtime.close();

    // Exactly one session created, exactly one close — the second close()
    // must be a no-op rather than a second attempt on an already-closed
    // session.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'close:auth-session']);
    expect(configs).toHaveLength(1);
    // `persistContext: false` is the property that makes this lane a pure READ
    // of the operator's logins: a trial that gets signed out mid-batch must
    // degrade that trial, not write the signed-out state back over the Context
    // every later batch depends on.
    expect(configs[0]).toEqual({
      contextId: 'ctx-auth',
      persistContext: false,
      liveView: true,
      lane: 'authenticated',
    });
  });

  it("reports 'browserbase' as its provider", async () => {
    const adapter = createBrowserbaseEvalBrowserAdapter({ env: { BROWSERBASE_API_KEY: 'key' } });
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: UNUSED_LOCAL_PROFILE_DIR,
      adapter,
    });

    expect(runtime.provider).toBe('browserbase');
    await runtime.close();
  });

  it('fails an authenticated lane with no BROWSERBASE_CONTEXT_ID, naming `npm run login`', async () => {
    // No createProvider override needed: `requireBrowserbaseContextId` must
    // throw before the adapter ever calls it, or this test would reach for a
    // provider double it never configured.
    const adapter = createBrowserbaseEvalBrowserAdapter({ env: { BROWSERBASE_API_KEY: 'key' } });
    const runtime = createEvalBrowserRuntime({
      env: {},
      authenticatedProfileDir: UNUSED_LOCAL_PROFILE_DIR,
      adapter,
    });

    await expect(runtime.withBrowser(true, async () => undefined)).rejects.toThrow(
      /npm run login/,
    );
    await runtime.close();
  });
});
