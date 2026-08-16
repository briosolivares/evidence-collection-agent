import {
  chmodSync,
  existsSync,
  mkdirSync,
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
import { BASH_SECRET_ENV_DENYLIST } from '../../cli/localExecution.js';
import { initManifest, readManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import {
  BASH_TOOL_TIMEOUT_MS,
  createBashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  type BashInput,
  type BashResult,
} from './bash.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal browser stub, only ever cast through `as unknown as
 * BrowserController` — the same pattern the browser tool suites use —
 * since these tests never launch a real browser. */
function fakeBrowserWithScriptSupport(
  setup: { cdpUrl: string; selectedPageTargetId: string } = {
    cdpUrl: 'ws://127.0.0.1:9999/devtools/browser/fake',
    selectedPageTargetId: 'FAKE-TARGET-1',
  },
): { browser: BrowserController; prepare: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn().mockResolvedValue(setup);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const browser = {
    prepareForBrowserScript: prepare,
    refreshAfterBrowserScript: refresh,
  } as unknown as BrowserController;
  return { browser, prepare, refresh };
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'bash-tool-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('bash tool', () => {
  const tool = createBashTool({ secretEnvDenylist: [] });
  const registry = createRegistry([tool]);

  function call(
    input: unknown,
    ctxOverrides: { abortSignal?: AbortSignal; browser?: BrowserController } = {},
  ) {
    return executeToolCall(
      registry,
      { id: `call-${Math.random().toString(36).slice(2)}`, name: 'bash', input },
      { runDir, ...ctxOverrides },
    );
  }

  function bodyOf(content: string): BashResult {
    return JSON.parse(content) as BashResult;
  }

  describe('tool definition', () => {
    it('declares itself state-changing and fully exclusive, since a shell command can touch anything', () => {
      expect(tool.getAccess({ command: 'x' } as BashInput)).toEqual({
        reads: [],
        writes: [],
        exclusive: true,
      });
    });

    it('declares an explicit tool-level timeoutMs comfortably above its own worst case', () => {
      expect(tool.timeoutMs).toBe(BASH_TOOL_TIMEOUT_MS);
      // Above the model's own timeout ceiling plus the 2s SIGTERM grace,
      // with real headroom left over for workspace-sync and browser-refresh.
      expect(BASH_TOOL_TIMEOUT_MS).toBeGreaterThan(MAX_BASH_TIMEOUT_MS + 2_000);
    });
  });

  describe('input schema', () => {
    it('rejects an unknown key', () => {
      const parsed = tool.inputSchema.safeParse({ command: 'echo hi', bogus: true });
      expect(parsed.success).toBe(false);
    });

    it('rejects an empty command', () => {
      expect(tool.inputSchema.safeParse({ command: '' }).success).toBe(false);
    });

    it('rejects a whitespace-only command', () => {
      expect(tool.inputSchema.safeParse({ command: '   \t\n' }).success).toBe(false);
    });

    it('defaults timeout_ms to 30_000, applied by execute rather than baked into the schema', () => {
      expect(DEFAULT_BASH_TIMEOUT_MS).toBe(30_000);
      const parsed = tool.inputSchema.safeParse({ command: 'echo hi' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.timeout_ms).toBeUndefined();
    });

    it('rejects a timeout_ms of 120_001 rather than clamping it', () => {
      expect(MAX_BASH_TIMEOUT_MS).toBe(120_000);
      const parsed = tool.inputSchema.safeParse({ command: 'echo hi', timeout_ms: 120_001 });
      expect(parsed.success).toBe(false);
    });

    it('accepts a timeout_ms exactly at the maximum', () => {
      expect(tool.inputSchema.safeParse({ command: 'echo hi', timeout_ms: 120_000 }).success).toBe(
        true,
      );
    });

    it('rejects a non-boolean uses_browser', () => {
      expect(
        tool.inputSchema.safeParse({ command: 'echo hi', uses_browser: 'yes' }).success,
      ).toBe(false);
    });
  });

  describe('workspace', () => {
    it('runs the command in exactly <runDir>/scratch/workspace, creating it when absent', async () => {
      const workspaceDir = join(runDir, 'scratch', 'workspace');
      expect(existsSync(workspaceDir)).toBe(false);

      const result = await call({ command: 'pwd' });
      expect(result.isError).toBe(false);
      const body = bodyOf(result.content);

      expect(realpathSync(body.stdout.trim())).toBe(realpathSync(workspaceDir));
      expect(existsSync(workspaceDir)).toBe(true);
      expect(statSync(workspaceDir).mode & 0o777).toBe(0o700);
    });

    it('leaves an already-existing workspace directory in place', async () => {
      const workspaceDir = join(runDir, 'scratch', 'workspace');
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(join(workspaceDir, 'preexisting.txt'), 'kept');

      const result = await call({ command: 'echo hi' });
      expect(result.isError).toBe(false);
      expect(readFileSync(join(workspaceDir, 'preexisting.txt'), 'utf8')).toBe('kept');
    });
  });

  describe('environment', () => {
    it('lets PATH and HOME survive into the child unchanged', async () => {
      const result = await call({ command: 'printf "%s\\n%s" "$PATH" "$HOME"' });
      const body = bodyOf(result.content);
      const [childPath, childHome] = body.stdout.split('\n');
      expect(childPath).toBe(process.env.PATH);
      expect(childHome).toBe(process.env.HOME);
    });

    it('strips every denylisted variable from the child environment', async () => {
      const secretRegistry = createRegistry([
        createBashTool({ secretEnvDenylist: ['MY_SECRET_TOKEN'] }),
      ]);
      process.env.MY_SECRET_TOKEN = 'super-secret-value';
      try {
        const result = await executeToolCall(
          secretRegistry,
          {
            id: 'call-denylist',
            name: 'bash',
            input: { command: 'printf "%s" "${MY_SECRET_TOKEN:-__unset__}"' },
          },
          { runDir },
        );
        const body = bodyOf(result.content);
        expect(body.stdout).toBe('__unset__');
      } finally {
        delete process.env.MY_SECRET_TOKEN;
      }
    });

    it('strips every real credential named in BASH_SECRET_ENV_DENYLIST, including BROWSERBASE_API_KEY', async () => {
      const realSecretRegistry = createRegistry([
        createBashTool({ secretEnvDenylist: BASH_SECRET_ENV_DENYLIST }),
      ]);
      const probes = {
        ANTHROPIC_API_KEY: 'sk-ant-test',
        GITHUB_TOKEN: 'ghp_test',
        BROWSERBASE_API_KEY: 'bb_test',
        SHERLOCK_CHROME_CDP_ENDPOINT: 'http://127.0.0.1:9222/private',
      };
      for (const [name, value] of Object.entries(probes)) {
        process.env[name] = value;
      }
      try {
        const result = await executeToolCall(
          realSecretRegistry,
          {
            id: 'call-real-denylist',
            name: 'bash',
            input: {
              command:
                'printf "%s\\n%s\\n%s\\n%s" "${ANTHROPIC_API_KEY:-__unset__}" "${GITHUB_TOKEN:-__unset__}" "${BROWSERBASE_API_KEY:-__unset__}" "${SHERLOCK_CHROME_CDP_ENDPOINT:-__unset__}"',
            },
          },
          { runDir },
        );
        const body = bodyOf(result.content);
        expect(body.stdout.split('\n')).toEqual([
          '__unset__',
          '__unset__',
          '__unset__',
          '__unset__',
        ]);
      } finally {
        for (const name of Object.keys(probes)) delete process.env[name];
      }
    });

    it('never mutates process.env itself, even when the denylist names a real live variable', async () => {
      const keysBefore = new Set(Object.keys(process.env));
      const pathBefore = process.env.PATH;
      const pathDenylistRegistry = createRegistry([
        createBashTool({ secretEnvDenylist: ['PATH'] }),
      ]);

      const result = await executeToolCall(
        pathDenylistRegistry,
        { id: 'call-no-mutate', name: 'bash', input: { command: 'printf "%s" "${PATH:-__unset__}"' } },
        { runDir },
      );

      // The child did not INHERIT our PATH — the denylist removed it. Note we
      // cannot assert it is unset: when PATH is absent from a shell's
      // environment, bash substitutes its own compiled-in default (something
      // like /usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.), so `${PATH:-...}`
      // never reports empty. What the denylist guarantees is that our value
      // did not cross over, which is exactly what this asserts.
      const childPath = bodyOf(result.content).stdout;
      expect(childPath).not.toBe(pathBefore);
      // ...and this process's own environment is completely untouched.
      expect(process.env.PATH).toBe(pathBefore);
      expect(new Set(Object.keys(process.env))).toEqual(keysBefore);
    });

    it('never sources BASH_ENV, even when it names a real file that would set a marker', async () => {
      const hookScript = join(runDir, 'hook.sh');
      writeFileSync(hookScript, 'export HOOK_MARKER=sourced\n');
      process.env.BASH_ENV = hookScript;
      try {
        const result = await call({ command: 'printf "%s" "${HOOK_MARKER:-unset}"' });
        expect(bodyOf(result.content).stdout).toBe('unset');
      } finally {
        delete process.env.BASH_ENV;
      }
    });

    it('never honors ENV either', async () => {
      process.env.ENV = '/dev/null';
      try {
        const result = await call({ command: 'printf "%s" "${ENV:-unset}"' });
        expect(bodyOf(result.content).stdout).toBe('unset');
      } finally {
        delete process.env.ENV;
      }
    });

    it('sets the four non-interactive Git/pager variables', async () => {
      const result = await call({
        command: 'printf "%s|%s|%s|%s" "$GIT_EDITOR" "$GIT_PAGER" "$PAGER" "$GIT_TERMINAL_PROMPT"',
      });
      expect(bodyOf(result.content).stdout).toBe('true|cat|cat|0');
    });
  });

  describe('cancellation', () => {
    it('never spawns when ctx.abortSignal is already aborted', async () => {
      const marker = join(runDir, 'should-not-exist.txt');
      const controller = new AbortController();
      controller.abort();

      const result = await call({ command: `touch '${marker}'` }, { abortSignal: controller.signal });
      expect(result.isError).toBe(false);
      const body = bodyOf(result.content);
      expect(body.status).toBe('cancelled');
      expect(body.changed_files).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe('pipeline integration', () => {
    it('reports a nonzero exit as a successful tool result, not an error', async () => {
      const result = await call({ command: 'exit 7' });
      expect(result.isError).toBe(false);
      const body = bodyOf(result.content);
      expect(body.status).toBe('exited');
      expect(body.exit_code).toBe(7);
    });

    it('offloads a large BashResult through the existing capResult path, with the normal preview shape', async () => {
      const result = await call({ command: 'yes A | head -c 60000' });
      expect(result.isError).toBe(false);
      const offloaded = JSON.parse(result.content) as {
        preview: string;
        offloadedTo: string;
        note: string;
      };
      expect(offloaded.offloadedTo).toMatch(/^scratch\/tool-output\/bash-\d+\.txt$/);
      expect(offloaded.note).toContain('50000-byte limit');
      const full = JSON.parse(
        readFileSync(join(runDir, offloaded.offloadedTo), 'utf8'),
      ) as BashResult;
      expect(full.stdout.length).toBeGreaterThanOrEqual(60_000);
    });

    it(
      'treats a spawn failure as an execution error, not a tool crash or a fabricated result',
      async () => {
        const workspaceDir = join(runDir, 'scratch', 'workspace');
        mkdirSync(workspaceDir, { recursive: true });
        // A workspace directory the process cannot even open makes the real
        // child_process.spawn() call fail before a process exists — the
        // same "pid stays undefined" failure runForegroundCommand's own
        // tests trigger via a nonexistent shellPath, which bash.ts cannot
        // be pointed at since its shellPath is fixed.
        chmodSync(workspaceDir, 0o000);
        try {
          const result = await call({ command: 'echo hi' });
          expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
        } finally {
          chmodSync(workspaceDir, 0o700);
        }
      },
      10_000,
    );

    it('treats a workspace-sync failure (a symlink left in the workspace) as an execution error', async () => {
      const result = await call({ command: 'ln -s /etc/hosts linked-file' });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    });
  });

  describe('workspace synchronization', () => {
    it('reports a file the command created after a normal exit', async () => {
      const result = await call({ command: 'echo hi > file.txt' });
      const body = bodyOf(result.content);
      expect(body.status).toBe('exited');
      expect(body.changed_files).toEqual([
        { path: 'scratch/workspace/file.txt', change: 'created' },
      ]);
    });

    it(
      'still syncs a file created before the command times out',
      async () => {
        const result = await call({ command: 'echo hi > file.txt; sleep 5', timeout_ms: 150 });
        const body = bodyOf(result.content);
        expect(body.status).toBe('timed_out');
        expect(body.changed_files).toEqual([
          { path: 'scratch/workspace/file.txt', change: 'created' },
        ]);
      },
      10_000,
    );

    it(
      'still syncs a file created before a mid-run cancellation',
      async () => {
        const controller = new AbortController();
        const promise = call(
          { command: 'echo hi > file.txt; sleep 5' },
          { abortSignal: controller.signal },
        );
        await wait(150);
        controller.abort();
        const result = await promise;
        const body = bodyOf(result.content);
        expect(body.status).toBe('cancelled');
        expect(body.changed_files).toEqual([
          { path: 'scratch/workspace/file.txt', change: 'created' },
        ]);
      },
      10_000,
    );

    it(
      'still syncs a file created before the output ceiling is exceeded',
      async () => {
        // Printable filler, deliberately NOT `cat /dev/zero`. The ceiling is
        // 10 MiB either way, but 10 MiB of NUL bytes balloons to roughly 60 MB
        // once JSON.stringify rewrites each one as a six-character unicode
        // escape, and hashing plus offloading that much text overran this
        // test's own timeout. The behavior under test is the workspace sync,
        // not the byte values the command happens to emit.
        const result = await call({ command: 'echo hi > file.txt; yes AAAAAAAAAAAAAAAA' });
        expect(result.isError).toBe(false);
        // Output this large always breaks the 50 KB result cap, so the model
        // receives the offload envelope rather than the BashResult itself.
        // Read the offloaded copy the same way the capResult test does.
        const offloaded = JSON.parse(result.content) as { offloadedTo: string };
        const body = JSON.parse(
          readFileSync(join(runDir, offloaded.offloadedTo), 'utf8'),
        ) as BashResult;
        expect(body.status).toBe('output_limit_exceeded');
        expect(body.changed_files).toEqual([
          { path: 'scratch/workspace/file.txt', change: 'created' },
        ]);
        // The point of the sync: provenance is recorded even when the command
        // was killed for flooding its output.
        expect(readManifest(runDir).artifacts.map((entry) => entry.filename)).toContain(
          'scratch/workspace/file.txt',
        );
      },
      15_000,
    );
  });

  describe('uses_browser', () => {
    it('calls neither lifecycle method when uses_browser is omitted (default false)', async () => {
      const { browser, prepare, refresh } = fakeBrowserWithScriptSupport();
      const result = await call({ command: 'echo hi' }, { browser });
      expect(result.isError).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('calls neither lifecycle method when uses_browser is explicitly false', async () => {
      const { browser, prepare, refresh } = fakeBrowserWithScriptSupport();
      const result = await call({ command: 'echo hi', uses_browser: false }, { browser });
      expect(result.isError).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('fails before spawning when uses_browser is true but the controller offers neither method', async () => {
      const marker = join(runDir, 'should-not-exist.txt');
      const browser = {} as unknown as BrowserController;

      const result = await call(
        { command: `touch '${marker}'`, uses_browser: true },
        { browser },
      );
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(result.content).toContain('uses_browser');
      expect(existsSync(marker)).toBe(false);
    });

    it('fails before spawning when the controller offers only one of the two required methods', async () => {
      const marker = join(runDir, 'should-not-exist.txt');
      const browser = {
        prepareForBrowserScript: vi.fn(),
        // refreshAfterBrowserScript intentionally absent.
      } as unknown as BrowserController;

      const result = await call(
        { command: `touch '${marker}'`, uses_browser: true },
        { browser },
      );
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(existsSync(marker)).toBe(false);
    });

    it('fails before spawning when uses_browser is true but ctx.browser is absent entirely', async () => {
      const marker = join(runDir, 'should-not-exist.txt');
      const result = await call({ command: `touch '${marker}'`, uses_browser: true });
      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(existsSync(marker)).toBe(false);
    });

    it('injects the exact helper/CDP/target env values and refreshes during cleanup', async () => {
      const customHelperUrl = 'file:///fake/browserScriptHelper.mjs';
      const { browser, prepare, refresh } = fakeBrowserWithScriptSupport({
        cdpUrl: 'ws://127.0.0.1:12345/devtools/browser/xyz',
        selectedPageTargetId: 'TARGET-ABC',
      });
      const helperRegistry = createRegistry([
        createBashTool({ secretEnvDenylist: [], helperUrl: customHelperUrl }),
      ]);

      const result = await executeToolCall(
        helperRegistry,
        {
          id: 'call-browser-env',
          name: 'bash',
          input: {
            command:
              'printf "%s|%s|%s" "$SHERLOCK_PLAYWRIGHT_HELPER_URL" "$SHERLOCK_CDP_URL" "$SHERLOCK_SELECTED_PAGE_TARGET_ID"',
            uses_browser: true,
          },
        },
        { runDir, browser },
      );

      expect(result.isError).toBe(false);
      const body = bodyOf(result.content);
      expect(body.stdout).toBe(
        `${customHelperUrl}|ws://127.0.0.1:12345/devtools/browser/xyz|TARGET-ABC`,
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('passes an explicit pageId through to prepareForBrowserScript', async () => {
      const { browser, prepare } = fakeBrowserWithScriptSupport();
      const result = await call(
        { command: 'echo hi', uses_browser: true, pageId: 'popup-1' },
        { browser },
      );
      expect(result.isError).toBe(false);
      expect(prepare).toHaveBeenCalledWith('popup-1');
    });

    it('calls prepareForBrowserScript with no pageId when omitted (the selected page)', async () => {
      const { browser, prepare } = fakeBrowserWithScriptSupport();
      const result = await call({ command: 'echo hi', uses_browser: true }, { browser });
      expect(result.isError).toBe(false);
      expect(prepare).toHaveBeenCalledWith(undefined);
    });

    it('resolves a default helper URL from its own module location when deps.helperUrl is omitted', async () => {
      const { browser } = fakeBrowserWithScriptSupport();
      const result = await call(
        { command: 'printf "%s" "$SHERLOCK_PLAYWRIGHT_HELPER_URL"', uses_browser: true },
        { browser },
      );
      const body = bodyOf(result.content);
      expect(body.stdout).toMatch(/^file:\/\/.*browserScriptHelper\.mjs$/);
    });

    it(
      'still refreshes the browser after a uses_browser command times out',
      async () => {
        const { browser, refresh } = fakeBrowserWithScriptSupport();
        const result = await call(
          { command: 'sleep 5', uses_browser: true, timeout_ms: 150 },
          { browser },
        );
        const body = bodyOf(result.content);
        expect(body.status).toBe('timed_out');
        expect(refresh).toHaveBeenCalledTimes(1);
      },
      10_000,
    );

    it(
      'still refreshes the browser after a uses_browser command is cancelled mid-run',
      async () => {
        const { browser, refresh } = fakeBrowserWithScriptSupport();
        const controller = new AbortController();
        const promise = call(
          { command: 'sleep 5', uses_browser: true },
          { abortSignal: controller.signal, browser },
        );
        await wait(150);
        controller.abort();
        const result = await promise;
        const body = bodyOf(result.content);
        expect(body.status).toBe('cancelled');
        expect(refresh).toHaveBeenCalledTimes(1);
      },
      10_000,
    );

    it('reports a browser-refresh cleanup failure without hiding the primary command outcome', async () => {
      const prepare = vi
        .fn()
        .mockResolvedValue({ cdpUrl: 'ws://x', selectedPageTargetId: 'T1' });
      const refresh = vi.fn().mockRejectedValue(new Error('cdp disconnected'));
      const browser = {
        prepareForBrowserScript: prepare,
        refreshAfterBrowserScript: refresh,
      } as unknown as BrowserController;

      const result = await call({ command: 'exit 7', uses_browser: true }, { browser });

      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      // The command's own outcome is not lost...
      expect(result.content).toContain('exit code 7');
      // ...and the cleanup failure is reported, not swallowed.
      expect(result.content).toContain('cdp disconnected');
    });
  });
});
