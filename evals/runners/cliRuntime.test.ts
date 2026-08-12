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
      withBrowser: async (requiresAuth, operation) => {
        policies.push(requiresAuth);
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
    const run = createBrowserBackedRunTask({
      browserRuntime,
      model: 'test-model',
      toolProfile: 'batch-enabled',
      runsBaseDir: '/runs',
      runTaskFn,
      onProgress: (...args) => progress.push(args),
    });

    await run('collect evidence', {
      taskName: 'auth-task',
      trialIndex: 0,
      trialNumber: 1,
      k: 2,
      startUrl: 'https://example.com/',
      requiresAuth: true,
      signal: new AbortController().signal,
    });

    expect(policies).toEqual([true]);
    expect(configs[0]).toMatchObject({
      browser,
      model: 'test-model',
      toolProfile: 'batch-enabled',
      runsBaseDir: '/runs',
      startUrl: 'https://example.com/',
    });
    expect(progress).toEqual([
      ['auth-task', 1, 2, { type: 'turn_start', turn: 1 }],
    ]);
  });

  it('drops non-HTTP(S) start URLs instead of passing them to runTask', async () => {
    const browser = { close: vi.fn() } as unknown as BrowserController;
    const configs: RunTaskConfig[] = [];
    const browserRuntime: EvalBrowserRuntime = {
      withBrowser: async (_requiresAuth, operation) => operation(browser),
      close: vi.fn(),
    };
    const runTaskFn = vi.fn(async (_taskText: string, config: RunTaskConfig) => {
      configs.push(config);
      return { runDir: '/runs/one' };
    });
    const run = createBrowserBackedRunTask({
      browserRuntime,
      model: 'test-model',
      toolProfile: 'atomic',
      runsBaseDir: '/runs',
      runTaskFn,
    });

    await run('write the answer', {
      taskName: 'blank-tab-task',
      trialIndex: 0,
      trialNumber: 1,
      k: 1,
      startUrl: 'about:blank',
      requiresAuth: false,
      signal: new AbortController().signal,
    });

    expect(configs[0]).not.toHaveProperty('startUrl');
  });
});
