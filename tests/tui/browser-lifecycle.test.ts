import { describe, expect, it, vi } from 'vitest';

import type { BrowserAdapter } from '../../src/browser/adapter.js';
import { createTuiRuntime } from '../../src/tui/bridge/runtime.js';
import type { RunHandle, RunSessionDeps } from '../../src/tui/bridge/runSession.js';
import { stubBrowser } from './stubBrowser.js';

function makeHandle(): RunHandle {
  return { cancel: vi.fn(), done: Promise.resolve({ status: 'cancelled' }) };
}

describe('TUI browser lifecycle', () => {
  it('launches one persistent browser and hands it to every run', async () => {
    const adapter = stubBrowser();
    const launchBrowser = vi.fn(async (): Promise<BrowserAdapter> => adapter);
    const seenDeps: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps) => {
      seenDeps.push(deps);
      return makeHandle();
    });

    const runtime = createTuiRuntime({ launchBrowser, startRunFn, runsBaseDir: '/tmp/runs' });
    await runtime.start();
    expect(launchBrowser).toHaveBeenCalledTimes(1);

    runtime.startRun('first', () => {});
    runtime.startRun('second', () => {});
    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(seenDeps).toHaveLength(2);
    expect(seenDeps[0]?.browser).toBe(adapter);
    expect(seenDeps[1]?.browser).toBe(adapter);
    expect(seenDeps[0]?.runsBaseDir).toBe('/tmp/runs');
  });

  it('closes the browser exactly once during teardown', async () => {
    const adapter = stubBrowser();
    const runtime = createTuiRuntime({
      launchBrowser: async () => adapter,
      startRunFn: () => makeHandle(),
    });
    await runtime.start();
    await runtime.shutdown();
    await runtime.shutdown();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('refuses to run before the browser session exists', async () => {
    const runtime = createTuiRuntime({
      launchBrowser: async () => stubBrowser(),
      startRunFn: () => makeHandle(),
    });
    expect(() => runtime.startRun('too early', () => {})).toThrow(/not started/);
    await runtime.start();
    await expect(runtime.start()).rejects.toThrow(/already started/);
  });
});
