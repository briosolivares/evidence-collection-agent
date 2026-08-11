import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserAdapter } from '../../src/browser/adapter.js';
import type { ModelStreamEvent } from '../../src/model/streamAssembly.js';
import {
  createTuiRuntime,
  isBrowserDeathMessage,
} from '../../src/tui/bridge/runtime.js';
import { startRun, type RunSessionDeps, type RunHandle } from '../../src/tui/bridge/runSession.js';
import { createInitialState, reduce, type StoreAction } from '../../src/tui/store/reducer.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { scriptedResponse } from './streamFixtures.js';
import { stubBrowser } from './stubBrowser.js';

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-errors-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

describe('mid-stream failure', () => {
  it('appends an error item and returns the session to idle', async () => {
    const events: UiEvent[] = [];

    // A stream that emits some prose, then dies with a non-abort error.
    async function* dyingStream(): AsyncGenerator<ModelStreamEvent> {
      yield* scriptedResponse([{ type: 'text', text: 'Starting the ' }], {
        input: 1,
        output: 1,
      }).slice(0, 3);
      throw new Error('socket hang up');
    }

    const handle = startRun('doomed investigation', {
      browser: stubBrowser(),
      onEvent: (event) => events.push(event),
      runsBaseDir,
      createStream: () => dyingStream(),
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ status: 'failed', message: 'socket hang up' });

    // Fold the emitted events through the reducer: the failure lands as a
    // persistent error item and the composer comes back (idle).
    let state = createInitialState();
    state = reduce(state, { type: 'submit_task', text: 'doomed investigation' });
    for (const event of events) {
      state = reduce(state, event as StoreAction);
    }
    expect(state.mode).toBe('idle');
    expect(state.live).toBeUndefined();
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'error',
      message: 'socket hang up',
    });
  });
});

describe('browser-death classification', () => {
  it('recognizes the adapter and Playwright shutdown messages', () => {
    expect(
      isBrowserDeathMessage('Target page, context or browser has been closed'),
    ).toBe(true);
    expect(isBrowserDeathMessage('The browser session is closed.')).toBe(true);
    expect(
      isBrowserDeathMessage('browserContext.newPage: Browser closed'),
    ).toBe(true);
    expect(isBrowserDeathMessage('Target closed')).toBe(true);
  });

  it('leaves ordinary run errors unclassified', () => {
    expect(isBrowserDeathMessage('socket hang up')).toBe(false);
    expect(isBrowserDeathMessage('HTTP 403 from sec.gov')).toBe(false);
    expect(isBrowserDeathMessage('tool_use block ended with unparseable input')).toBe(false);
  });
});

describe('browser relaunch on next submit', () => {
  it('relaunches a fresh browser after a browser-death failure', async () => {
    const adapters: BrowserAdapter[] = [];
    const launchBrowser = vi.fn(async () => {
      const adapter = stubBrowser();
      adapters.push(adapter);
      return adapter;
    });

    let call = 0;
    const seen: RunSessionDeps[] = [];
    const startRunFn = vi.fn((_task: string, deps: RunSessionDeps): RunHandle => {
      seen.push(deps);
      call += 1;
      const outcome =
        call === 1
          ? ({
              status: 'failed',
              message: 'browserContext.newPage: Target page, context or browser has been closed',
            } as const)
          : ({ status: 'completed', finalText: 'ok', runDir: '/runs/x' } as const);
      return { cancel: vi.fn(), done: Promise.resolve(outcome) };
    });

    const runtime = createTuiRuntime({ launchBrowser, startRunFn });
    await runtime.start();
    expect(launchBrowser).toHaveBeenCalledTimes(1);

    const first = await runtime.startRun('dies', () => {}).done;
    expect(first.status).toBe('failed');
    expect(launchBrowser).toHaveBeenCalledTimes(1); // not yet — relaunch is lazy

    const second = await runtime.startRun('recovers', () => {}).done;
    expect(second.status).toBe('completed');
    expect(launchBrowser).toHaveBeenCalledTimes(2); // relaunched on next submit
    expect(seen[1]?.browser).toBe(adapters[1]); // the fresh session
    expect(adapters[0]?.close).toHaveBeenCalled(); // corpse cleaned up
  });

  it('an ordinary failure does not trigger a relaunch', async () => {
    const launchBrowser = vi.fn(async () => stubBrowser());
    const startRunFn = vi.fn(
      (): RunHandle => ({
        cancel: vi.fn(),
        done: Promise.resolve({ status: 'failed', message: 'HTTP 500' } as const),
      }),
    );
    const runtime = createTuiRuntime({ launchBrowser, startRunFn });
    await runtime.start();
    await runtime.startRun('a', () => {}).done;
    await runtime.startRun('b', () => {}).done;
    expect(launchBrowser).toHaveBeenCalledTimes(1);
  });

  it('a failed relaunch reports run_failed instead of crashing', async () => {
    let launches = 0;
    const launchBrowser = vi.fn(async () => {
      launches += 1;
      if (launches > 1) throw new Error('no chrome anymore');
      return stubBrowser();
    });
    const startRunFn = vi.fn(
      (): RunHandle => ({
        cancel: vi.fn(),
        done: Promise.resolve({
          status: 'failed',
          message: 'browser has been closed',
        } as const),
      }),
    );
    const runtime = createTuiRuntime({ launchBrowser, startRunFn, now: () => 7 });
    await runtime.start();
    await runtime.startRun('dies', () => {}).done;

    const events: UiEvent[] = [];
    const outcome = await runtime.startRun('cannot recover', (event) => events.push(event)).done;
    expect(outcome.status).toBe('failed');
    expect(events).toEqual([
      {
        type: 'run_failed',
        message: 'browser relaunch failed: no chrome anymore',
        at: 7,
      },
    ]);
  });
});
