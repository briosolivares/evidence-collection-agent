import { describe, expect, it, vi } from 'vitest';

import type { EvalBrowserRuntime } from '../../evals/runners/browserRuntime.js';
import type { BrowserController } from '../../src/browser/controller.js';
import { createTuiEvalRuntime } from '../../src/tui/bridge/evalRuntime.js';
import type { RunSessionDeps } from '../../src/tui/bridge/runSession.js';
import { stubBrowser } from './stubBrowser.js';

function evalOptions(headed: boolean) {
  return {
    taskName: headed ? 'headed' : 'normal',
    trialIndex: 0,
    trialNumber: 1,
    k: 1,
    startUrl: 'https://example.com/',
    headed,
    signal: new AbortController().signal,
  };
}

describe('createTuiEvalRuntime', () => {
  it('uses explicit managed eval browsers for both normal and headed local trials', async () => {
    const browser = stubBrowser();
    const policies: boolean[] = [];
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (headed, operation) => {
        policies.push(headed);
        return operation(browser);
      },
      close: vi.fn(async () => undefined),
    };
    const seenDeps: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps) => {
      seenDeps.push(deps);
      return {
        cancel: vi.fn(),
        done: Promise.resolve({
          status: 'verified',
          finalText: '',
          runDir: '/runs/normal',
        } as const),
      };
    });
    const authenticatedRunner = vi.fn(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ status: 'verified', finalText: '', runDir: '/runs/auth' } as const),
    }));
    const runtime = createTuiEvalRuntime({
      authenticatedRunner,
      authenticatedProfileDir: '/persistent/profile',
      browserRuntime,
      startRunFn,
      runsBaseDir: '/runs',
    });

    await runtime.startRun('normal task', () => {}, evalOptions(false)).done;
    await runtime.startRun('auth task', () => {}, evalOptions(true)).done;
    await runtime.close();

    expect(policies).toEqual([false, true]);
    expect(seenDeps[0]).toMatchObject({ browser, runsBaseDir: '/runs' });
    expect(seenDeps[1]).toMatchObject({
      browser,
      runsBaseDir: '/runs',
      authenticated: true,
      javascriptPolicy: 'allow',
    });
    expect(authenticatedRunner).not.toHaveBeenCalled();
    expect(browserRuntime.close).toHaveBeenCalledTimes(1);
  });

  it('keeps Browserbase headed trials on the existing remote interactive session', async () => {
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'browserbase',
      withBrowser: vi.fn(async (_headed, operation) => operation(stubBrowser())),
      close: vi.fn(async () => undefined),
    };
    const authenticatedRunner = vi.fn(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ status: 'verified', finalText: '', runDir: '/runs/auth' } as const),
    }));
    const runtime = createTuiEvalRuntime({
      authenticatedRunner,
      authenticatedProfileDir: '/persistent/profile',
      browserRuntime,
    });

    await runtime.startRun('auth task', () => {}, evalOptions(true)).done;

    expect(authenticatedRunner).toHaveBeenCalledOnce();
    expect(browserRuntime.withBrowser).not.toHaveBeenCalled();
  });

  it('forwards the dialog resolver to headed trials only — headless trials stay unassisted', async () => {
    const browser = stubBrowser();
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (_headed, operation) => operation(browser),
      close: vi.fn(async () => undefined),
    };
    const seenDeps: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps) => {
      seenDeps.push(deps);
      return {
        cancel: vi.fn(),
        done: Promise.resolve({
          status: 'verified',
          finalText: '',
          runDir: '/runs/normal',
        } as const),
      };
    });
    const authenticatedRunner = vi.fn(() => ({
      cancel: vi.fn(),
      done: Promise.resolve({ status: 'verified', finalText: '', runDir: '/runs/auth' } as const),
    }));
    const runtime = createTuiEvalRuntime({
      authenticatedRunner,
      authenticatedProfileDir: '/persistent/profile',
      browserRuntime,
      startRunFn,
    });
    const requestPermission = vi.fn();

    await runtime.startRun('auth task', () => {}, { ...evalOptions(true), requestPermission }).done;
    await runtime.startRun('normal task', () => {}, { ...evalOptions(false), requestPermission })
      .done;

    // Headed: the resolver reaches the managed persistent-profile run.
    expect(seenDeps[0]).toHaveProperty('requestPermission', requestPermission);
    expect(seenDeps[0]).toMatchObject({ authenticated: true, javascriptPolicy: 'allow' });
    expect(authenticatedRunner).not.toHaveBeenCalled();
    // Headless: deliberately withheld — interactive tools fail closed,
    // keeping this lane's scores comparable to CLI batches.
    expect(seenDeps[1]).not.toHaveProperty('requestPermission');
    expect(seenDeps[1]).toMatchObject({ authenticated: false, javascriptPolicy: 'allow' });
  });

  it('cancels a normal run whose browser is still being acquired', async () => {
    let releaseBrowser!: (browser: BrowserController) => void;
    const browserPromise = new Promise<BrowserController>((resolve) => {
      releaseBrowser = resolve;
    });
    const innerCancel = vi.fn();
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (_headed, operation) => operation(await browserPromise),
      close: vi.fn(async () => undefined),
    };
    const runtime = createTuiEvalRuntime({
      authenticatedRunner: vi.fn(),
      authenticatedProfileDir: '/persistent/profile',
      browserRuntime,
      startRunFn: () => ({
        cancel: innerCancel,
        done: Promise.resolve({ status: 'cancelled' }),
      }),
    });

    const handle = runtime.startRun('normal task', () => {}, evalOptions(false));
    handle.cancel();
    releaseBrowser(stubBrowser());
    await handle.done;
    expect(innerCancel).toHaveBeenCalledTimes(1);
  });
});
