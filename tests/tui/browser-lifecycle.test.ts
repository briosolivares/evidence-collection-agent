import { describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { BrowserSessionCreationOptions } from '../../src/browser/sessionProvider.js';
import { createTuiRuntime } from '../../src/tui/bridge/runtime.js';
import type { RunHandle, RunSessionDeps } from '../../src/tui/bridge/runSession.js';
import type { UiEvent } from '../../src/tui/store/state.js';
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
    expect(createSession).toHaveBeenCalledTimes(0);

    await runtime.startRun('first', () => {}).done;
    await runtime.startRun('second', () => {}).done;
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(seenDeps).toHaveLength(2);
    expect(seenDeps[0]?.browser).toBe(controller);
    expect(seenDeps[1]?.browser).toBe(controller);
    expect(seenDeps[0]?.runsBaseDir).toBe('/tmp/runs');
  });

  it('routes lazy attached-browser setup states into the submitting run', async () => {
    const controller = stubBrowser();
    const createSession = vi.fn(async (options?: BrowserSessionCreationOptions) => {
      options?.onSetupState?.('Waiting for Chrome approval.');
      return controller;
    });
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn: () => makeHandle(),
    });
    const events: UiEvent[] = [];

    expect(createSession).not.toHaveBeenCalled();
    await runtime.startRun('use the browser', (event) => events.push(event)).done;

    expect(events).toContainEqual({
      type: 'browser_setup',
      message: 'Waiting for Chrome approval.',
    });
  });

  it('closes the browser exactly once during teardown', async () => {
    const controller = stubBrowser();
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession: async () => controller },
      startRunFn: () => makeHandle(),
    });
    await runtime.startRun('launch it', () => {}).done;
    await runtime.shutdown();
    await runtime.shutdown();
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it('does not launch headed Chrome when shut down without an interactive run', async () => {
    const createSession = vi.fn(async () => stubBrowser());
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn: () => makeHandle(),
    });
    await runtime.shutdown();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('owns and closes a pre-attached controller even when no run starts', async () => {
    const initialBrowser = stubBrowser();
    const createSession = vi.fn(async () => stubBrowser());
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      initialBrowser,
      startRunFn: () => makeHandle(),
    });

    await runtime.shutdown();

    expect(createSession).not.toHaveBeenCalled();
    expect(initialBrowser.close).toHaveBeenCalledOnce();
  });

  it('emits browser_session once for a controller carrying diagnostics, and never for one without', async () => {
    const remoteController: BrowserController = {
      ...stubBrowser(),
      sessionDiagnostics: {
        provider: 'browserbase',
        sessionId: 'bb_1',
        liveViewUrl: 'https://live.example/1',
      },
    };
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession: async () => remoteController },
      startRunFn: () => makeHandle(),
    });
    const events: UiEvent[] = [];
    await runtime.startRun('first', (event) => events.push(event)).done;

    const sessionEvents = events.filter((event) => event.type === 'browser_session');
    expect(sessionEvents).toEqual([
      {
        type: 'browser_session',
        provider: 'browserbase',
        sessionId: 'bb_1',
        liveViewUrl: 'https://live.example/1',
      },
    ]);

    // A local controller carries no diagnostics, so nothing is emitted.
    const localController = stubBrowser();
    expect(localController.sessionDiagnostics).toBeUndefined();
    const localRuntime = createTuiRuntime({
      browserSessionProvider: { createSession: async () => localController },
      startRunFn: () => makeHandle(),
    });
    const localEvents: UiEvent[] = [];
    await localRuntime.startRun('first', (event) => localEvents.push(event)).done;
    expect(localEvents.filter((event) => event.type === 'browser_session')).toHaveLength(0);
  });
});
