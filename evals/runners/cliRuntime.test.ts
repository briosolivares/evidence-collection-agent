import { describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import type { RunTaskConfig } from '../../src/cli/runTask.js';
import type { EvalBrowserRuntime } from './browserRuntime.js';
import { createBrowserBackedRunTask } from './cliRuntime.js';

describe('createBrowserBackedRunTask', () => {
  it('selects browser policy from metadata and forwards run configuration', async () => {
    const browser = { close: vi.fn() } as unknown as BrowserController;
    const policies: boolean[] = [];
    const configs: RunTaskConfig[] = [];
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (headed, operation) => {
        policies.push(headed);
        return operation(browser);
      },
      close: vi.fn(),
    };
    const runTaskFn = vi.fn(async (_taskText: string, config: RunTaskConfig) => {
      configs.push(config);
      config.onProgress?.({ type: 'turn_start', turn: 1 });
      return { runDir: '/runs/one' };
    });
    const progress: unknown[][] = [];
    const signal = new AbortController().signal;
    const run = createBrowserBackedRunTask({
      browserRuntime,
      model: 'test-model',
      runsBaseDir: '/runs',
      runTaskFn,
      onProgress: (...args) => progress.push(args),
    });

    await run('collect evidence', {
      taskName: 'headed-task',
      trialIndex: 0,
      trialNumber: 1,
      k: 2,
      startUrl: 'https://example.com/',
      headed: true,
      signal,
    });

    expect(policies).toEqual([true]);
    expect(configs[0]).toMatchObject({
      browser,
      model: 'test-model',
      runsBaseDir: '/runs',
      startUrl: 'https://example.com/',
      signal,
    });
    expect(progress).toEqual([
      ['headed-task', 1, 2, { type: 'turn_start', turn: 1 }],
    ]);
  });

  it('drops non-HTTP(S) start URLs instead of passing them to runTask', async () => {
    const browser = { close: vi.fn() } as unknown as BrowserController;
    const configs: RunTaskConfig[] = [];
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (_headed, operation) => operation(browser),
      close: vi.fn(),
    };
    const runTaskFn = vi.fn(async (_taskText: string, config: RunTaskConfig) => {
      configs.push(config);
      return { runDir: '/runs/one' };
    });
    const run = createBrowserBackedRunTask({
      browserRuntime,
      model: 'test-model',
      runsBaseDir: '/runs',
      runTaskFn,
    });

    await run('write the answer', {
      taskName: 'blank-tab-task',
      trialIndex: 0,
      trialNumber: 1,
      k: 1,
      startUrl: 'about:blank',
      headed: false,
      signal: new AbortController().signal,
    });

    expect(configs[0]).not.toHaveProperty('startUrl');
  });
});

describe('unanswerable questions in an unattended batch', () => {
  const runOnce = async () => {
    const browser = { close: vi.fn() } as unknown as BrowserController;
    const browserRuntime: EvalBrowserRuntime = {
      provider: 'local',
      withBrowser: async (_headed, operation) => operation(browser),
      close: vi.fn(),
    };
    const notices: string[] = [];
    let decision: unknown;
    const runTaskFn = vi.fn(async (_taskText: string, config: RunTaskConfig) => {
      decision = await config.requestPermission?.({
        toolName: 'ask_user',
        input: { question: 'Please sign in to Google, then tell me when done.' },
      });
      return { runDir: '/runs/one' };
    });

    await createBrowserBackedRunTask({
      browserRuntime,
      model: 'test-model',
      runsBaseDir: '/runs',
      runTaskFn,
      onHumanNeeded: (message) => notices.push(message),
    })('collect evidence', {
      taskName: 'mit_sororities',
      trialIndex: 0,
      trialNumber: 2,
      k: 3,
      headed: true,
      signal: new AbortController().signal,
    });

    return { notices, decision };
  };

  it('announces the blocked trial, naming the task, trial, and question', async () => {
    const { notices } = await runOnce();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('HUMAN NEEDED');
    expect(notices[0]).toContain('mit_sororities trial 2/3');
    expect(notices[0]).toContain('Please sign in to Google');
  });

  // The recorded failure: told to "proceed without it", an agent blocked by a
  // signed-out Google account went looking for a way around the wall and
  // started creating an account. The denial has to close that door explicitly.
  it('denies with instructions to report the blocker, not to work around it', async () => {
    const { decision } = await runOnce();

    expect(decision).toMatchObject({ behavior: 'deny' });
    const feedback = (decision as { feedback: string }).feedback;
    expect(feedback).toMatch(/do not create an account/i);
    expect(feedback).toMatch(/report the blocker/i);
  });
});
