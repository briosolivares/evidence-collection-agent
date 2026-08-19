import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../browser/controller.js';
import { initManifest, readManifest } from '../../run/artifacts.js';
import type { ForegroundCommandResult } from './runForegroundCommand.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolCtx } from '../registry.js';
import {
  BASH_MAX_OUTPUT_BYTES,
  BASH_TOOL_TIMEOUT_MS,
  createBashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  type BashResult,
  type BashToolDeps,
} from './bash.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-bash-'));
  initManifest(runDir, 'exercise the v3 bash tool');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function callTool(
  deps: BashToolDeps,
  input: unknown,
  overrides: Partial<ToolCtx> = {},
) {
  return executeToolCall(
    createRegistry([createBashTool(deps)]),
    { id: 'bash-1', name: 'bash', input },
    { runDir, ...overrides },
  );
}

function parseSuccess(content: string): BashResult {
  return JSON.parse(content) as BashResult;
}

function exited(
  overrides: Partial<ForegroundCommandResult> = {},
): ForegroundCommandResult {
  return {
    status: 'exited',
    exitCode: 0,
    terminationSignal: null,
    durationMs: 12,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await wait(10);
  }
}

describe('v3 bash tool', () => {
  it('has a strict browser-free schema and an exclusive bounded contract', () => {
    const tool = createBashTool({ secretEnvDenylist: [] });

    expect(tool.name).toBe('bash');
    expect(tool.getAccess({ command: 'true' })).toEqual({
      reads: [],
      writes: [],
      exclusive: true,
    });
    expect(tool.timeoutMs).toBe(BASH_TOOL_TIMEOUT_MS);
    expect(BASH_TOOL_TIMEOUT_MS).toBeGreaterThan(MAX_BASH_TIMEOUT_MS + 2_000);
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(30_000);
    expect(MAX_BASH_TIMEOUT_MS).toBe(120_000);

    expect(tool.inputSchema.safeParse({ command: 'printf ok' }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({ command: 'printf ok', timeout_ms: 120_000 }).success,
    ).toBe(true);
    for (const input of [
      { command: '' },
      { command: '   \n' },
      { command: 'true', timeout_ms: 0 },
      { command: 'true', timeout_ms: 120_001 },
      { command: 'true', uses_browser: true },
      { command: 'true', pageId: 'page-1' },
      { command: 'true', page_id: 'page-1' },
    ]) {
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('runs in owner-only scratch/workspace and reconciles output on nonzero exit', async () => {
    const workspace = join(runDir, 'scratch', 'workspace');
    const result = await callTool(
      { secretEnvDenylist: [] },
      {
        command:
          'pwd; printf "warning" >&2; printf "evidence" > result.txt; exit 7',
      },
    );

    expect(result.isError).toBe(false);
    const parsed = parseSuccess(result.content);
    expect(parsed).toMatchObject({
      status: 'exited',
      exit_code: 7,
      termination_signal: null,
      stderr: 'warning',
      changed_files: [
        { path: 'scratch/workspace/result.txt', change: 'created' },
      ],
    });
    expect(realpathSync(parsed.stdout.trim())).toBe(realpathSync(workspace));
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('evidence');
    expect(readManifest(runDir).artifacts).toEqual([
      expect.objectContaining({ filename: 'scratch/workspace/result.txt' }),
    ]);
  });

  it('passes fixed execution limits and a sanitized noninteractive environment', async () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/safe/bin',
      SAFE_SETTING: 'visible',
      EXACT_SECRET: 'exact-value',
      SECRET_FAMILY_TOKEN: 'prefix-value',
      BASH_ENV: '/tmp/bash-startup',
      ENV: '/tmp/posix-startup',
      SHERLOCK_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser/private',
      SHERLOCK_PLAYWRIGHT_HELPER_URL: 'file:///private/browserScriptHelper.mjs',
      SHERLOCK_SELECTED_PAGE_TARGET_ID: 'target-private',
      CDP_ENDPOINT: 'http://127.0.0.1:9222/json/version',
      DISGUISED_ENDPOINT: 'wss://remote.example/devtools/browser/private',
      GIT_EDITOR: 'vim',
      GIT_PAGER: 'less',
      PAGER: 'more',
      GIT_TERMINAL_PROMPT: '1',
    };
    const browser = new Proxy(
      {},
      {
        get() {
          throw new Error('v3 bash must not inspect the browser controller');
        },
      },
    ) as BrowserController;
    const runCommand = vi.fn(async (options) => {
      expect(options).toMatchObject({
        shellPath: '/bin/bash',
        command: 'printf ok',
        cwd: join(runDir, 'scratch', 'workspace'),
        timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
        maxOutputBytes: BASH_MAX_OUTPUT_BYTES,
      });
      expect(options.env).toEqual({
        PATH: '/safe/bin',
        SAFE_SETTING: 'visible',
        GIT_EDITOR: 'true',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      });
      return exited({ stdout: 'ok' });
    });

    const result = await callTool(
      {
        secretEnvDenylist: ['EXACT_SECRET', 'SECRET_FAMILY_'],
        environment: () => source,
        runCommand,
      },
      { command: 'printf ok' },
      { browser },
    );

    expect(result.isError).toBe(false);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(source.GIT_EDITOR).toBe('vim');
    expect(source.SHERLOCK_CDP_URL).toContain('/devtools/browser/');
  });

  it('uses an explicit timeout without clamping it', async () => {
    const runCommand = vi.fn(async (options) => {
      expect(options.timeoutMs).toBe(4_321);
      return exited();
    });

    const result = await callTool(
      { secretEnvDenylist: [], runCommand },
      { command: 'true', timeout_ms: 4_321 },
    );

    expect(result.isError).toBe(false);
  });

  it.each([
    ['exited', 0, null],
    ['timed_out', null, null],
    ['output_limit_exceeded', null, null],
    ['cancelled', null, null],
  ] as const)(
    'reconciles workspace changes after a %s runner outcome',
    async (status, exitCode, terminationSignal) => {
      const filename = `${status}.txt`;
      const result = await callTool(
        {
          secretEnvDenylist: [],
          runCommand: async (options) => {
            writeFileSync(join(options.cwd, filename), status);
            return exited({ status, exitCode, terminationSignal });
          },
        },
        { command: 'represented by test runner' },
      );

      expect(result.isError).toBe(false);
      expect(parseSuccess(result.content)).toMatchObject({
        status,
        changed_files: [
          { path: `scratch/workspace/${filename}`, change: 'created' },
        ],
      });
    },
  );

  it('reconciles files even when the command runner rejects', async () => {
    const result = await callTool(
      {
        secretEnvDenylist: [],
        runCommand: async (options) => {
          writeFileSync(join(options.cwd, 'before-failure.txt'), 'survived');
          throw new Error('spawn failed');
        },
      },
      { command: 'never started' },
    );

    expect(result).toMatchObject({
      isError: true,
      errorKind: 'execution_error',
    });
    expect(result.content).toContain('spawn failed');
    expect(readManifest(runDir).artifacts).toEqual([
      expect.objectContaining({
        filename: 'scratch/workspace/before-failure.txt',
      }),
    ]);
  });

  it('fails loudly when workspace reconciliation finds a symlink', async () => {
    const result = await callTool(
      { secretEnvDenylist: [] },
      { command: 'ln -s /etc/hosts linked-file' },
    );

    expect(result).toMatchObject({
      isError: true,
      errorKind: 'execution_error',
    });
    expect(result.content).toMatch(/workspace sync failed.*symlink/i);
  });

  it('does not spawn, create the workspace, or inspect env when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const environment = vi.fn(() => ({ SHOULD_NOT: 'be read' }));
    const runCommand = vi.fn(async () => exited());

    const result = await callTool(
      { secretEnvDenylist: [], environment, runCommand },
      { command: 'touch should-not-exist' },
      { abortSignal: controller.signal },
    );

    expect(result.isError).toBe(false);
    expect(parseSuccess(result.content)).toEqual({
      status: 'cancelled',
      exit_code: null,
      termination_signal: null,
      duration_ms: 0,
      stdout: '',
      stderr: '',
      changed_files: [],
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'scratch', 'workspace'))).toBe(false);
  });

  it(
    'cancels the process group, kills descendants, and reconciles surviving files',
    async () => {
      const workspace = join(runDir, 'scratch', 'workspace');
      const controller = new AbortController();
      const pending = callTool(
        { secretEnvDenylist: [] },
        {
          command:
            "printf kept > before-cancel.txt; " +
            "(sleep 0.4 && printf leaked > descendant.txt) & sleep 5",
        },
        { abortSignal: controller.signal },
      );

      await waitForPath(join(workspace, 'before-cancel.txt'));
      controller.abort();
      const result = await pending;

      expect(result.isError).toBe(false);
      expect(parseSuccess(result.content)).toMatchObject({
        status: 'cancelled',
        changed_files: [
          {
            path: 'scratch/workspace/before-cancel.txt',
            change: 'created',
          },
        ],
      });
      await wait(600);
      expect(existsSync(join(workspace, 'descendant.txt'))).toBe(false);
    },
    10_000,
  );

  it('does not source BASH_ENV startup code', async () => {
    const startup = join(runDir, 'malicious-bash-env');
    writeFileSync(startup, 'export STARTUP_MARKER=loaded\n');

    const result = await callTool(
      {
        secretEnvDenylist: [],
        environment: () => ({ ...process.env, BASH_ENV: startup }),
      },
      { command: 'printf "%s" "${STARTUP_MARKER:-not-loaded}"' },
    );

    expect(result.isError).toBe(false);
    expect(parseSuccess(result.content).stdout).toBe('not-loaded');
  });
});
