import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { CallModel } from '../../src/loop/messages.js';
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

// A scripted `set_output_contract` call, hermetic and immediate — this
// module's own `createStream` seam is shared across every role's model
// client (worker, initializer, verifier: see runSession.ts and
// runTask.ts), so leaving the initializer to fall back to its production
// `makeContractInitializerModelDriver` default would make it consume this
// suite's `dyingStream` and throw exactly as the worker does, but for the
// wrong reason (an initializer failure instead of a WORKER mid-stream
// failure). Scripting `harness.initializerCallModel`/`verifierCallModel`
// directly keeps those roles off both the network and the dying stream.
const initializerCallModel: CallModel = async () => ({
  content: [
    {
      type: 'tool_use',
      id: 'tu_contract',
      name: 'set_output_contract',
      input: {
        contract: {
          outputs: [{ id: 'notes', kind: 'screenshots', count: { minimum: 1 } }],
        },
      },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
});

// Never actually reached by this suite's dying-worker test (the worker's
// stream dies before any submission), but scripted anyway so nothing about
// this file depends on the verifier's production default staying unreached.
const verifierCallModel: CallModel = async () => ({
  content: [
    { type: 'tool_use', id: 'tu_verify', name: 'report_verification', input: { status: 'verified', findings: [] } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 2 },
});

let runsBaseDir: string;

beforeEach(() => {
  runsBaseDir = mkdtempSync(join(tmpdir(), 'sherlock-errors-'));
});

afterEach(() => {
  rmSync(runsBaseDir, { recursive: true, force: true });
});

describe('mid-stream failure', () => {
  it('preserves the v3 incomplete diagnostic and returns the session to idle', async () => {
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
      // The initializer and verifier are scripted off the network entirely
      // (see the module-level fakes above); createStream below is consumed
      // ONLY by the worker's own model client, so it is the only role whose
      // stream dies.
      harness: { initializerCallModel, verifierCallModel },
      createStream: () => dyingStream(),
    });
    const outcome = await handle.done;
    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'worker_incomplete',
      detail: 'socket hang up',
    });

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
      message: expect.stringContaining('socket hang up'),
    });
  });
});

describe('browser-death classification', () => {
  it('recognizes the controller and Playwright shutdown messages', () => {
    expect(
      isBrowserDeathMessage('Target page, context or browser has been closed'),
    ).toBe(true);
    expect(isBrowserDeathMessage('The browser session is closed.')).toBe(true);
    expect(
      isBrowserDeathMessage('browserContext.newPage: Browser closed'),
    ).toBe(true);
    expect(isBrowserDeathMessage('Target closed')).toBe(true);
    expect(
      isBrowserDeathMessage(
        'Task-page ownership cleanup previously failed; retry cleanup or replace the controller.',
      ),
    ).toBe(true);
    expect(
      isBrowserDeathMessage(
        'run reached verified, but terminal cleanup failed: browser pages: close failed',
      ),
    ).toBe(true);
  });

  it('leaves ordinary run errors unclassified', () => {
    expect(isBrowserDeathMessage('socket hang up')).toBe(false);
    expect(isBrowserDeathMessage('HTTP 403 from sec.gov')).toBe(false);
    expect(isBrowserDeathMessage('tool_use block ended with unparseable input')).toBe(false);
  });
});

describe('browser relaunch on next submit', () => {
  it('preserves a cancelled cleanup failure and relaunches before the next run', async () => {
    const controllers: BrowserController[] = [];
    const createSession = vi.fn(async () => {
      const controller = stubBrowser();
      controllers.push(controller);
      return controller;
    });
    let calls = 0;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const startRunFn = (task: string, deps: RunSessionDeps): RunHandle =>
      startRun(task, {
        ...deps,
        runTaskFn: async (_task, config) => {
          calls += 1;
          if (calls === 1) {
            markFirstStarted();
            const signal = config.signal;
            if (signal === undefined) throw new Error('test expected a run signal');
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new Error(
              'run reached cancelled, but terminal cleanup failed: browser pages: close failed',
            );
          }
          return { status: 'verified', finalText: 'ok', runDir: '/runs/recovered' };
        },
      });
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn,
    });
    await runtime.start();

    const first = runtime.startRun('cancel during cleanup', () => {});
    await firstStarted;
    first.cancel();
    await expect(first.done).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('terminal cleanup failed'),
    });

    await expect(runtime.startRun('next task', () => {}).done).resolves.toMatchObject({
      status: 'verified',
    });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(controllers[0]?.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'browser disconnect',
      'browserContext.newPage: Target page, context or browser has been closed',
    ],
    [
      'poisoned task-page cleanup',
      'Task-page ownership cleanup previously failed; retry cleanup or replace the controller.',
    ],
  ])('relaunches a fresh browser after %s', async (_label, failureMessage) => {
    const controllers: BrowserController[] = [];
    const createSession = vi.fn(async () => {
      const controller = stubBrowser();
      controllers.push(controller);
      return controller;
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
              message: failureMessage,
            } as const)
          : ({ status: 'verified', finalText: 'ok', runDir: '/runs/x' } as const);
      return { cancel: vi.fn(), done: Promise.resolve(outcome) };
    });

    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn,
    });
    await runtime.start();
    expect(createSession).toHaveBeenCalledTimes(0);

    const first = await runtime.startRun('dies', () => {}).done;
    expect(first.status).toBe('failed');
    expect(createSession).toHaveBeenCalledTimes(1); // first run launched lazily

    const second = await runtime.startRun('recovers', () => {}).done;
    expect(second.status).toBe('verified');
    expect(createSession).toHaveBeenCalledTimes(2); // relaunched on next submit
    expect(seen[1]?.browser).toBe(controllers[1]); // the fresh session
    expect(controllers[0]?.close).toHaveBeenCalled(); // corpse cleaned up
  });

  it('an ordinary failure does not trigger a relaunch', async () => {
    const createSession = vi.fn(async () => stubBrowser());
    const startRunFn = vi.fn(
      (): RunHandle => ({
        cancel: vi.fn(),
        done: Promise.resolve({ status: 'failed', message: 'HTTP 500' } as const),
      }),
    );
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn,
    });
    await runtime.start();
    await runtime.startRun('a', () => {}).done;
    await runtime.startRun('b', () => {}).done;
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('a failed relaunch reports run_failed instead of crashing', async () => {
    let launches = 0;
    const createSession = vi.fn(async () => {
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
    const runtime = createTuiRuntime({
      browserSessionProvider: { createSession },
      startRunFn,
      now: () => 7,
    });
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
