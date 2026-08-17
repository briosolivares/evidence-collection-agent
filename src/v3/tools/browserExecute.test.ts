import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserCommandSession,
  BrowserController,
  BrowserPage,
} from '../../browser/controller.js';
import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../../tools/pipeline.js';
import { createRegistry, type ToolCtx } from '../../tools/registry.js';
import type {
  BrowserProgramOptions,
  BrowserProgramResult,
} from '../browser/runner.js';
import {
  BROWSER_EXECUTE_MAX_OUTPUT_BYTES,
  BROWSER_EXECUTE_POLICY_DENIED_MESSAGE,
  BROWSER_UPLOAD_MAX_FILE_BYTES,
  DEFAULT_BROWSER_EXECUTE_TIMEOUT_MS,
  MAX_BROWSER_EXECUTE_TIMEOUT_MS,
  createBrowserExecuteTool,
  type BrowserExecuteResult,
  type BrowserExecuteToolDeps,
} from './browserExecute.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-browser-execute-'));
  initManifest(runDir, 'exercise the v3 browser tool');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const PAGE: BrowserPage = {
  pageId: 'page-task',
  url: 'https://example.test/report',
  active: true,
};

interface FakeBrowserOptions {
  closeError?: Error;
  refreshError?: Error;
  pagesError?: Error;
  dialogsError?: Error;
}

function fakeBrowser(options: FakeBrowserOptions = {}) {
  const events: string[] = [];
  const send = vi.fn(async () => ({ result: { value: 42 } }));
  const close = vi.fn(async () => {
    events.push('close');
    if (options.closeError) throw options.closeError;
  });
  const upload = vi.fn(async () => undefined);
  const session: BrowserCommandSession = {
    pageId: 'page-task',
    targetId: 'target-task',
    send,
    navigate: vi.fn(async (url: string) => ({
      pageId: 'page-task',
      targetId: 'target-task',
      url,
      title: '',
    })),
    upload,
    close,
  };
  const openCommandSession = vi.fn(async () => {
    events.push('open');
    return session;
  });
  const refreshAfterExternalCommands = vi.fn(async () => {
    events.push('refresh');
    if (options.refreshError) throw options.refreshError;
  });
  const pages = vi.fn(async () => {
    events.push('pages');
    if (options.pagesError) throw options.pagesError;
    return [PAGE];
  });
  const listPendingDialogs = vi.fn(() => {
    events.push('dialogs');
    if (options.dialogsError) throw options.dialogsError;
    return [];
  });
  const browser = {
    openCommandSession,
    refreshAfterExternalCommands,
    pages,
    listPendingDialogs,
  } as unknown as BrowserController;
  return {
    browser,
    session,
    send,
    upload,
    close,
    openCommandSession,
    refreshAfterExternalCommands,
    pages,
    listPendingDialogs,
    events,
  };
}

function callTool(
  deps: BrowserExecuteToolDeps,
  browser: BrowserController | undefined,
  input: unknown,
  overrides: Partial<ToolCtx> = {},
) {
  const tool = createBrowserExecuteTool(deps);
  return executeToolCall(
    createRegistry([tool]),
    { id: 'browser-program-1', name: 'browser_execute', input },
    { runDir, browser, ...overrides },
  );
}

function parseSuccess(content: string): BrowserExecuteResult {
  return JSON.parse(content) as BrowserExecuteResult;
}

function exited(
  overrides: Partial<BrowserProgramResult> = {},
): BrowserProgramResult {
  return {
    status: 'exited',
    durationMs: 25,
    value: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

describe('browser_execute tool', () => {
  it('pins the requested page, routes CDP, sanitizes env, syncs files, and refreshes', async () => {
    const fake = fakeBrowser();
    let received: BrowserProgramOptions | undefined;
    const runProgram = vi.fn(async (options: BrowserProgramOptions) => {
      fake.events.push('run');
      received = options;
      const cdpValue = await options.sendCdp('Runtime.evaluate', {
        expression: '21 * 2',
      });
      writeFileSync(join(options.cwd, 'notes.txt'), 'durable scratch bytes');
      await options.upload(73, 'notes.txt');
      return exited({
        value: { cdpValue },
        stdout: 'program output\n',
        stderr: 'program warning\n',
      });
    });

    const result = await callTool(
      {
        javascriptPolicy: 'allow',
        secretEnvDenylist: ['INTERNAL_CAPABILITY_'],
        environment: () => ({
          SAFE_SETTING: 'visible',
          INTERNAL_CAPABILITY_VALUE: 'configured-secret',
          LANGFUSE_SECRET_KEY: 'tracing-secret',
          SHERLOCK_CDP_URL: 'wss://secret.example/devtools/browser/control',
          NODE_OPTIONS: '--inspect=127.0.0.1:9229',
        }),
        runProgram,
      },
      fake.browser,
      { code: 'return browser.pageInfo();', page_id: 'page-task' },
    );

    expect(result.isError).toBe(false);
    const parsed = parseSuccess(result.content);
    expect(parsed).toMatchObject({
      status: 'exited',
      duration_ms: 25,
      stdout: 'program output\n',
      stderr: 'program warning\n',
      pages: [PAGE],
      pending_dialogs: [],
      changed_files: [
        { path: 'scratch/workspace/notes.txt', change: 'created' },
      ],
    });
    expect(received).toMatchObject({
      cwd: join(runDir, 'scratch/workspace'),
      env: { SAFE_SETTING: 'visible' },
      timeoutMs: DEFAULT_BROWSER_EXECUTE_TIMEOUT_MS,
      maxOutputBytes: BROWSER_EXECUTE_MAX_OUTPUT_BYTES,
      page: { pageId: 'page-task', targetId: 'target-task' },
    });
    expect(fake.openCommandSession).toHaveBeenCalledExactlyOnceWith('page-task');
    expect(fake.send).toHaveBeenCalledExactlyOnceWith('Runtime.evaluate', {
      expression: '21 * 2',
    });
    expect(fake.upload).toHaveBeenCalledExactlyOnceWith(
      73,
      join(runDir, 'scratch/workspace/notes.txt'),
    );
    expect(fake.events).toEqual([
      'open',
      'run',
      'close',
      'refresh',
      'pages',
      'dialogs',
    ]);
    expect(JSON.stringify(result)).not.toContain('configured-secret');
    expect(JSON.stringify(result)).not.toContain('tracing-secret');
    expect(JSON.stringify(result)).not.toContain('secret.example');
  });

  it('rejects traversal, symlink, and oversized upload paths before a browser effect', async () => {
    const fake = fakeBrowser();
    const runProgram = vi.fn(async (options: BrowserProgramOptions) => {
      writeFileSync(join(options.cwd, 'real.csv'), 'name\nAda\n');
      symlinkSync('real.csv', join(options.cwd, 'linked.csv'));
      writeFileSync(join(options.cwd, 'oversized.bin'), '');
      truncateSync(
        join(options.cwd, 'oversized.bin'),
        BROWSER_UPLOAD_MAX_FILE_BYTES + 1,
      );
      const failures: string[] = [];
      for (const path of ['../outside.csv', 'linked.csv', 'oversized.bin']) {
        try {
          await options.upload(73, path);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      unlinkSync(join(options.cwd, 'linked.csv'));
      unlinkSync(join(options.cwd, 'oversized.bin'));
      return exited({ value: failures });
    });

    const result = await callTool(
      { javascriptPolicy: 'allow', secretEnvDenylist: [], runProgram },
      fake.browser,
      { code: `return 'test seam';` },
    );

    expect(result.isError, result.content).toBe(false);
    expect(parseSuccess(result.content).value).toEqual([
      expect.stringContaining('must stay within scratch/workspace'),
      expect.stringContaining('must not contain symbolic links'),
      expect.stringContaining(`exceeds ${BROWSER_UPLOAD_MAX_FILE_BYTES} bytes`),
    ]);
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it('refuses deny before controller, session, child, helper, environment, or workspace access', async () => {
    const fake = fakeBrowser();
    const environment = vi.fn(() => ({ SAFE_SETTING: 'unreachable' }));
    const runProgram = vi.fn(async (options: BrowserProgramOptions) => {
      await options.sendCdp('Runtime.evaluate', {
        expression: 'document.cookie',
      });
      return exited();
    });
    const abortController = new AbortController();
    abortController.abort();
    const busyRegistry = {
      markAbandoned: vi.fn(),
      waitUntilFree: vi.fn(async () => true),
      drainUntilFree: vi.fn(async () => undefined),
    };

    const result = await callTool(
      {
        javascriptPolicy: 'deny',
        secretEnvDenylist: [],
        environment,
        runProgram,
      },
      fake.browser,
      {
        code:
          `return browser.cdp('Runtime.evaluate', ` +
          `{ expression: 'document.cookie' });`,
      },
      { abortSignal: abortController.signal, busyRegistry },
    );

    expect(result).toEqual({
      toolCallId: 'browser-program-1',
      isError: true,
      errorKind: 'execution_error',
      content:
        `Tool "browser_execute" failed: ` +
        BROWSER_EXECUTE_POLICY_DENIED_MESSAGE,
    });
    expect(existsSync(join(runDir, 'scratch/workspace'))).toBe(false);
    expect(busyRegistry.waitUntilFree).toHaveBeenCalledWith(
      { reads: [], writes: [] },
      expect.any(Number),
    );
    expect(fake.openCommandSession).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(runProgram).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();
    expect(fake.refreshAfterExternalCommands).not.toHaveBeenCalled();
    expect(fake.pages).not.toHaveBeenCalled();
    expect(fake.listPendingDialogs).not.toHaveBeenCalled();
  });

  it('uses the active page when page_id is omitted and preserves program failure as data', async () => {
    const fake = fakeBrowser();
    const runProgram = vi.fn(async () =>
      exited({
        status: 'failed',
        value: undefined,
        error: { name: 'TypeError', message: 'page program failed' },
      }),
    );

    const result = await callTool(
      { javascriptPolicy: 'allow', secretEnvDenylist: [], runProgram },
      fake.browser,
      { code: "throw new TypeError('page program failed')" },
    );

    expect(result.isError).toBe(false);
    expect(parseSuccess(result.content)).toMatchObject({
      status: 'failed',
      error: { name: 'TypeError', message: 'page program failed' },
      pages: [PAGE],
      pending_dialogs: [],
    });
    expect(fake.openCommandSession).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.refreshAfterExternalCommands).toHaveBeenCalledOnce();
  });

  it('attempts every cleanup step, keeps the primary error, and redacts capabilities', async () => {
    const fake = fakeBrowser({
      closeError: new Error(
        'detach failed at wss://connect.browserbase.com/session?token=close-secret',
      ),
      refreshError: new Error(
        'refresh failed at http://127.0.0.1:9222/devtools/browser/refresh-secret',
      ),
      pagesError: new Error(
        'list failed at https://api.browserbase.com/v1/sessions/page-secret',
      ),
      dialogsError: new Error(
        'dialogs failed at wss://private.example/devtools/page/dialog-secret',
      ),
    });
    const runProgram = vi.fn(async () => {
      fake.events.push('run');
      throw new Error(
        'spawn failed at wss://private.example/devtools/browser/primary-secret',
      );
    });

    const result = await callTool(
      { javascriptPolicy: 'allow', secretEnvDenylist: [], runProgram },
      fake.browser,
      { code: 'return 1;' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('browser program failed to run');
    expect(result.content).toContain('cleanup also failed');
    expect(result.content).toContain('[REDACTED_WEBSOCKET_URL]');
    expect(result.content).toContain('[REDACTED_CDP_URL]');
    expect(result.content).not.toContain('primary-secret');
    expect(result.content).not.toContain('close-secret');
    expect(result.content).not.toContain('refresh-secret');
    expect(result.content).not.toContain('page-secret');
    expect(result.content).not.toContain('dialog-secret');
    expect(fake.events).toEqual([
      'open',
      'run',
      'close',
      'refresh',
      'pages',
      'dialogs',
    ]);
  });

  it('does not create a workspace, open a session, or spawn when already cancelled', async () => {
    const fake = fakeBrowser();
    const runProgram = vi.fn(async () => exited());
    const abortController = new AbortController();
    abortController.abort();

    const result = await callTool(
      { javascriptPolicy: 'allow', secretEnvDenylist: [], runProgram },
      fake.browser,
      { code: 'return 1;' },
      { abortSignal: abortController.signal },
    );

    expect(result.isError).toBe(false);
    expect(parseSuccess(result.content)).toEqual({
      status: 'cancelled',
      duration_ms: 0,
      stdout: '',
      stderr: '',
      changed_files: [],
      pages: [],
      pending_dialogs: [],
    });
    expect(existsSync(join(runDir, 'scratch/workspace'))).toBe(false);
    expect(fake.openCommandSession).not.toHaveBeenCalled();
    expect(runProgram).not.toHaveBeenCalled();
    expect(fake.refreshAfterExternalCommands).not.toHaveBeenCalled();
  });

  it('rejects unknown keys, blank code, and an over-limit timeout before touching the browser', async () => {
    const fake = fakeBrowser();
    const runProgram = vi.fn(async () => exited());
    const deps = {
      javascriptPolicy: 'allow' as const,
      secretEnvDenylist: [],
      runProgram,
    };

    const [unknown, blank, timeout] = await Promise.all([
      callTool(deps, fake.browser, { code: 'return 1;', pageId: 'wrong-shape' }),
      callTool(deps, fake.browser, { code: '   ' }),
      callTool(deps, fake.browser, {
        code: 'return 1;',
        timeout_ms: MAX_BROWSER_EXECUTE_TIMEOUT_MS + 1,
      }),
    ]);

    expect(unknown).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(blank).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(timeout).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(fake.openCommandSession).not.toHaveBeenCalled();
    expect(runProgram).not.toHaveBeenCalled();
  });

  it('fails clearly without a browser and does not create the workspace', async () => {
    const runProgram = vi.fn(async () => exited());
    const result = await callTool(
      { javascriptPolicy: 'allow', secretEnvDenylist: [], runProgram },
      undefined,
      { code: 'return 1;' },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('requires an active browser session');
    expect(existsSync(join(runDir, 'scratch/workspace'))).toBe(false);
    expect(runProgram).not.toHaveBeenCalled();
  });
});
