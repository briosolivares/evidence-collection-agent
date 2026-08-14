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
  it('uses isolated browsers for normal trials and delegates headed trials', async () => {
    const browser = stubBrowser();
    const policies: boolean[] = [];
    const browserRuntime: EvalBrowserRuntime = {
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
        done: Promise.resolve({ status: 'verified', finalText: '', runDir: '/runs/normal' } as const),
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

    expect(policies).toEqual([false]);
    expect(seenDeps[0]).toMatchObject({ browser, runsBaseDir: '/runs' });
    expect(authenticatedRunner).toHaveBeenCalledTimes(1);
    expect(browserRuntime.close).toHaveBeenCalledTimes(1);
  });

  it('forwards the dialog resolver to headed trials only — headless trials stay unassisted', async () => {
    const browser = stubBrowser();
    const browserRuntime: EvalBrowserRuntime = {
      withBrowser: async (_headed, operation) => operation(browser),
      close: vi.fn(async () => undefined),
    };
    const seenDeps: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps) => {
      seenDeps.push(deps);
      return {
        cancel: vi.fn(),
        done: Promise.resolve({ status: 'verified', finalText: '', runDir: '/runs/normal' } as const),
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

    // Headed: the resolver rides through to the persistent-session runner.
    expect(authenticatedRunner).toHaveBeenCalledWith(
      'auth task',
      expect.any(Function),
      expect.objectContaining({ requestPermission }),
    );
    // Headless: deliberately withheld — interactive tools fail closed,
    // keeping this lane's scores comparable to CLI batches.
    expect(seenDeps[0]).not.toHaveProperty('requestPermission');
  });

  it('cancels a normal run whose browser is still being acquired', async () => {
    let releaseBrowser!: (browser: BrowserController) => void;
    const browserPromise = new Promise<BrowserController>((resolve) => {
      releaseBrowser = resolve;
    });
    const innerCancel = vi.fn();
    const browserRuntime: EvalBrowserRuntime = {
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
