import { describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import { createTuiRuntime } from '../../src/tui/bridge/runtime.js';
import type { RunHandle, RunSessionDeps } from '../../src/tui/bridge/runSession.js';
import { stubBrowser } from './stubBrowser.js';

function makeHandle(): RunHandle {
  return { cancel: vi.fn(), done: Promise.resolve({ status: 'cancelled' }) };
}

describe('TUI browser lifecycle', () => {
  it('launches one persistent browser and hands it to every run', async () => {
    const controller = stubBrowser();
    const createSession = vi.fn(async (): Promise<BrowserController> => controller);
    const seenDeps: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps) => {
      seenDeps.push(deps);
      return makeHandle();
    });

    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn,
      runsBaseDir: '/tmp/runs',
    });
    await runtime.start();
    expect(createSession).toHaveBeenCalledTimes(0);

    await runtime.startRun('first', () => {}).done;
    await runtime.startRun('second', () => {}).done;
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(seenDeps).toHaveLength(2);
    expect(seenDeps[0]?.browser).toBe(controller);
    expect(seenDeps[1]?.browser).toBe(controller);
    expect(seenDeps[0]?.runsBaseDir).toBe('/tmp/runs');
  });

  it('closes the browser exactly once during teardown', async () => {
    const controller = stubBrowser();
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession: async () => controller },
      startRunFn: () => makeHandle(),
    });
    await runtime.start();
    await runtime.startRun('launch it', () => {}).done;
    await runtime.shutdown();
    await runtime.shutdown();
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it('does not launch headed Chrome when started and shut down without an interactive run', async () => {
    const createSession = vi.fn(async () => stubBrowser());
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn: () => makeHandle(),
    });
    await runtime.start();
    await runtime.shutdown();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses to run before the browser session exists', async () => {
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession: async () => stubBrowser() },
      startRunFn: () => makeHandle(),
    });
    expect(() => runtime.startRun('too early', () => {})).toThrow(/not started/);
    await runtime.start();
    await expect(runtime.start()).rejects.toThrow(/already started/);
  });
});
