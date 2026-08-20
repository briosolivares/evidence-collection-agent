import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as parentDeathWatchdogModule from '../../../src/process/parentDeathWatchdog.js';
import {
  BROWSER_PROGRAM_LIMITS,
  runBrowserProgram,
  type BrowserProgramOptions,
} from '../../../src/tools/browserExecute/runner.js';
import { createControlledWatchdog, wait, waitForPath } from '../../helpers/processFixtures.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 1_000_000;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sherlock-browser-runner-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function options(
  code: string,
  overrides: Partial<BrowserProgramOptions> = {},
): BrowserProgramOptions {
  return {
    code,
    cwd,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    page: { pageId: 'sherlock-page-1', targetId: 'current-target' },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_OUTPUT_BYTES,
    sendCdp: async () => ({}),
    navigate: async (url) => ({
      pageId: 'sherlock-page-1',
      targetId: 'current-target',
      url,
      title: '',
    }),
    upload: async () => undefined,
    ...overrides,
  };
}

describe('runBrowserProgram', () => {
  it('routes raw CDP over private request/response IPC and returns a JSON value', async () => {
    const sendCdp = vi.fn(async (method: string, params: Record<string, unknown>) => ({
      method,
      echoed: params,
    }));

    const result = await runBrowserProgram(
      options(`return browser.cdp('Example.echo', { answer: 42 });`, { sendCdp }),
    );

    expect(result).toMatchObject({
      status: 'exited',
      value: { method: 'Example.echo', echoed: { answer: 42 } },
      stdout: '',
      stderr: '',
    });
    expect(result.error).toBeUndefined();
    expect(sendCdp).toHaveBeenCalledOnce();
    expect(sendCdp).toHaveBeenCalledWith('Example.echo', { answer: 42 });
  });

  it('routes a bounded upload request over host IPC without exposing browser authority', async () => {
    const upload = vi.fn(async () => undefined);

    const result = await runBrowserProgram(
      options(
        `await browser.upload(73, 'evidence.csv');
         await browser.upload('framed.csv', {
           selector: 'input[type="file"]',
           frameUrlIncludes: '/picker'
         });
         return 'attached';`,
        { upload },
      ),
    );

    expect(result).toMatchObject({ status: 'exited', value: 'attached' });
    expect(upload.mock.calls).toEqual([
      [73, 'evidence.csv'],
      [{ selector: 'input[type="file"]', frameUrlIncludes: '/picker' }, 'framed.csv'],
    ]);
  });

  it('bounds upload paths and host request count before forwarding effects', async () => {
    const oversizedUpload = vi.fn(async () => undefined);
    const oversized = await runBrowserProgram(
      options(
        `return browser.upload(1, 'x'.repeat(${BROWSER_PROGRAM_LIMITS.maxWorkspacePathBytes + 1}));`,
        { upload: oversizedUpload },
      ),
    );
    expect(oversized).toMatchObject({ status: 'failed' });
    expect(oversized.error?.message).toContain('upload workspace path exceeds');
    expect(oversizedUpload).not.toHaveBeenCalled();

    const upload = vi.fn(async () => undefined);
    const budget = await runBrowserProgram(
      options(
        `for (let index = 0; index <= ${BROWSER_PROGRAM_LIMITS.maxHostCalls}; index += 1) {
          await browser.upload(1, 'evidence.csv');
        }`,
        { upload },
      ),
    );
    expect(budget).toMatchObject({ status: 'protocol_error' });
    expect(budget.error?.message).toContain('host request budget');
    expect(upload).toHaveBeenCalledTimes(BROWSER_PROGRAM_LIMITS.maxHostCalls);
  });

  it('rejects malformed host IPC and redacts upload-effect errors', async () => {
    const malformedUpload = vi.fn(async () => undefined);
    const malformed = await runBrowserProgram(
      options(
        `process.send({
          version: 1,
          kind: 'host_request',
          id: 1,
          operation: 'upload',
          params: { backendDOMNodeId: 1, workspacePath: 'x.csv', extra: true }
        });
        await new Promise(() => {});`,
        { upload: malformedUpload },
      ),
    );
    expect(malformed).toMatchObject({ status: 'protocol_error' });
    expect(malformed.error?.message).toContain('malformed browser host request');
    expect(malformedUpload).not.toHaveBeenCalled();

    const redacted = await runBrowserProgram(
      options(`return browser.upload(1, 'evidence.csv');`, {
        upload: async () => {
          throw new Error(
            'upload failed at wss://private.example/devtools/browser/session-control',
          );
        },
      }),
    );
    expect(redacted).toMatchObject({ status: 'failed' });
    expect(redacted.error?.message).toContain('[REDACTED_WEBSOCKET_URL]');
    expect(JSON.stringify(redacted)).not.toContain('session-control');
  });

  it('imports a confined run-local module relative to cwd and reuses its module instance', async () => {
    writeFileSync(
      join(cwd, 'helper.mjs'),
      `globalThis.__sherlockHelperLoads = (globalThis.__sherlockHelperLoads ?? 0) + 1;\n` +
        `export const loads = globalThis.__sherlockHelperLoads;\n` +
        `export const answer = () => 42;\n`,
    );

    const result = await runBrowserProgram(
      options(`
        const first = await browser.importModule('./helper.mjs');
        const second = await browser.importModule('helper.mjs');
        return {
          same: first === second,
          firstLoads: first.loads,
          secondLoads: second.loads,
          answer: second.answer()
        };
      `),
    );

    expect(result).toMatchObject({
      status: 'exited',
      value: { same: true, firstLoads: 1, secondLoads: 1, answer: 42 },
    });
  });

  it('starts run-local modules with fresh process state for every program', async () => {
    writeFileSync(
      join(cwd, 'fresh-helper.mjs'),
      `globalThis.__sherlockFreshLoads = (globalThis.__sherlockFreshLoads ?? 0) + 1;\n` +
        `export const loads = globalThis.__sherlockFreshLoads;\n`,
    );

    const code = `return (await browser.importModule('./fresh-helper.mjs')).loads;`;
    const first = await runBrowserProgram(options(code));
    const second = await runBrowserProgram(options(code));

    expect(first).toMatchObject({ status: 'exited', value: 1 });
    expect(second).toMatchObject({ status: 'exited', value: 1 });
  });

  it('rejects traversal, symbolic links, and oversized workspace modules', async () => {
    writeFileSync(join(cwd, 'real-helper.mjs'), 'export const value = 1;\n');
    symlinkSync('real-helper.mjs', join(cwd, 'linked-helper.mjs'));
    writeFileSync(join(cwd, 'oversized-helper.mjs'), ' '.repeat(1_048_577));

    const traversal = await runBrowserProgram(
      options(`return browser.importModule('../outside.mjs');`),
    );
    const symlink = await runBrowserProgram(
      options(`return browser.importModule('./linked-helper.mjs');`),
    );
    const oversized = await runBrowserProgram(
      options(`return browser.importModule('./oversized-helper.mjs');`),
    );

    expect(traversal).toMatchObject({ status: 'failed' });
    expect(traversal.error?.message).toContain('must stay within scratch/workspace');
    expect(symlink).toMatchObject({ status: 'failed' });
    expect(symlink.error?.message).toContain('must not contain symbolic links');
    expect(oversized).toMatchObject({ status: 'failed' });
    expect(oversized.error?.message).toContain('workspace module exceeds 1048576 bytes');
  });

  it('composes protected helpers from pinned CDP and host navigation requests', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const navigate = vi.fn(async (url: string) => ({
      pageId: 'sherlock-page-1',
      targetId: 'current-target',
      url,
      title: 'Settled destination',
    }));
    const sendCdp = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('location.href')) {
          return {
            result: {
              value: {
                url: 'https://example.test/current',
                title: 'Current page',
                width: 800,
                height: 600,
                scrollX: 10,
                scrollY: 20,
                pageWidth: 1200,
                pageHeight: 2400,
              },
            },
          };
        }
        return { result: { value: true } };
      }
      if (method === 'Target.getTargetInfo') {
        const targetId = String(params.targetId ?? 'current-target');
        return {
          targetInfo: {
            targetId,
            title: targetId === 'new-target' ? 'New page' : 'Current page',
            url:
              targetId === 'new-target'
                ? 'https://example.test/new'
                : 'https://example.test/current',
            type: 'page',
          },
        };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: '1',
              ignored: false,
              role: { value: 'button' },
              name: { value: 'Save report' },
              backendDOMNodeId: 17,
            },
            {
              nodeId: '2',
              ignored: false,
              role: { value: 'heading' },
              name: { value: 'Unrelated' },
            },
          ],
        };
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            {
              targetId: 'current-target',
              title: 'Current page',
              url: 'https://example.test/current',
              type: 'page',
            },
            { targetId: 'worker', title: '', url: '', type: 'service_worker' },
          ],
        };
      }
      if (method === 'Target.createTarget') return { targetId: 'new-target' };
      return {};
    };

    const result = await runBrowserProgram(
      options(
        `
          const info = await browser.pageInfo();
          const ax = await browser.accessibility({ role: 'button', text: 'save', maxDepth: 8, maxNodes: 10 });
          const navigation = await browser.goto('https://example.test/destination', { timeoutMs: 1234, waitUntil: 'load' });
          await browser.click(100, 200, { button: 'left', clickCount: 2 });
          await browser.type('hello');
          await browser.press('Enter');
          await browser.scroll(400, 300, 500, 25);
          const loaded = await browser.waitForLoad({ timeoutMs: 50, pollIntervalMs: 10 });
          const found = await browser.waitFor('globalThis.ready === true', { timeoutMs: 50, pollIntervalMs: 10 });
          const listed = await browser.pages();
          const opened = await browser.open('https://example.test/new');
          await browser.activate('current-target');
          await browser.close('new-target');
          return { info, ax, navigation, loaded, found, listed, opened };
        `,
        { sendCdp, navigate },
      ),
    );

    expect(result.status).toBe('exited');
    expect(result.value).toMatchObject({
      info: {
        pageId: 'sherlock-page-1',
        targetId: 'current-target',
        viewport: { width: 800, height: 600, scrollX: 10, scrollY: 20 },
        page: { width: 1200, height: 2400 },
      },
      ax: {
        nodes: [{ nodeId: '1', role: 'button', name: 'Save report', backendDOMNodeId: 17 }],
        totalNodes: 2,
        matchedNodes: 1,
        truncated: false,
      },
      navigation: {
        pageId: 'sherlock-page-1',
        targetId: 'current-target',
        url: 'https://example.test/destination',
        title: 'Settled destination',
      },
      loaded: true,
      found: true,
      listed: [{ targetId: 'current-target' }],
      opened: { targetId: 'new-target', title: 'New page' },
    });
    expect(calls).toContainEqual({
      method: 'Accessibility.getFullAXTree',
      params: { depth: 8 },
    });
    expect(calls).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: expect.objectContaining({ type: 'mousePressed', x: 100, y: 200, clickCount: 2 }),
    });
    expect(calls).toContainEqual({
      method: 'Input.insertText',
      params: { text: 'hello' },
    });
    expect(calls).toContainEqual({
      method: 'Target.closeTarget',
      params: { targetId: 'new-target' },
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test/destination', {
      timeoutMs: 1234,
      waitUntil: 'load',
    });
  });

  it('rejects unsupported goto options instead of silently ignoring them', async () => {
    const navigate = vi.fn(options('').navigate);
    const result = await runBrowserProgram(
      options(`return browser.goto('https://example.test', { timeout: 15_000 });`, {
        navigate,
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('use timeoutMs instead of timeout');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns the controller page identity and fails if CDP reports a different target', async () => {
    const matching = await runBrowserProgram(
      options(`return browser.pageInfo();`, {
        page: { pageId: 'sherlock-page-77', targetId: 'target-77' },
        sendCdp: async (method) => {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: 'target-77',
                type: 'page',
                title: 'Pinned',
                url: 'https://example.test/pinned',
              },
            };
          }
          return {
            result: {
              value: {
                url: 'https://example.test/pinned',
                title: 'Pinned',
                width: 800,
                height: 600,
                scrollX: 0,
                scrollY: 0,
                pageWidth: 800,
                pageHeight: 1200,
              },
            },
          };
        },
      }),
    );
    expect(matching).toMatchObject({
      status: 'exited',
      value: { pageId: 'sherlock-page-77', targetId: 'target-77' },
    });

    const mismatched = await runBrowserProgram(
      options(`return browser.pageInfo();`, {
        page: { pageId: 'sherlock-page-77', targetId: 'target-77' },
        sendCdp: async (method) => {
          if (method === 'Target.getTargetInfo') {
            return {
              targetInfo: {
                targetId: 'different-target',
                type: 'page',
                title: 'Wrong page',
                url: 'https://example.test/wrong',
              },
            };
          }
          return {
            result: {
              value: {
                url: 'https://example.test/wrong',
                title: 'Wrong page',
                width: 800,
                height: 600,
                scrollX: 0,
                scrollY: 0,
                pageWidth: 800,
                pageHeight: 1200,
              },
            },
          };
        },
      }),
    );
    expect(mismatched.status).toBe('failed');
    expect(mismatched.error?.message).toContain(
      'command session is pinned to target-77, but CDP reported different-target',
    );
  });

  it('handles JavaScript dialogs through bounded accept/dismiss CDP calls', async () => {
    const sendCdp = vi.fn(async () => ({}));
    const result = await runBrowserProgram(
      options(
        `
          await browser.handleDialog('accept', 'typed response');
          await browser.handleDialog('dismiss');
          return true;
        `,
        { sendCdp },
      ),
    );

    expect(result).toMatchObject({ status: 'exited', value: true });
    expect(sendCdp).toHaveBeenNthCalledWith(1, 'Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'typed response',
    });
    expect(sendCdp).toHaveBeenNthCalledWith(2, 'Page.handleJavaScriptDialog', {
      accept: false,
    });
  });

  it('rejects invalid or oversized dialog arguments before sending CDP', async () => {
    const dismissSender = vi.fn(async () => ({}));
    const dismissWithPrompt = await runBrowserProgram(
      options(`return browser.handleDialog('dismiss', 'not allowed');`, {
        sendCdp: dismissSender,
      }),
    );
    expect(dismissWithPrompt.status).toBe('failed');
    expect(dismissWithPrompt.error?.message).toContain(
      'promptText is allowed only when accepting a dialog',
    );
    expect(dismissSender).not.toHaveBeenCalled();

    const oversizedSender = vi.fn(async () => ({}));
    const oversizedPrompt = await runBrowserProgram(
      options(`return browser.handleDialog('accept', 'x'.repeat(16385));`, {
        sendCdp: oversizedSender,
      }),
    );
    expect(oversizedPrompt.status).toBe('failed');
    expect(oversizedPrompt.error?.message).toContain('dialog promptText exceeds 16384 bytes');
    expect(oversizedSender).not.toHaveBeenCalled();
  });

  it('evaluates JavaScript with promises/value return and reports clear page exceptions', async () => {
    const success = await runBrowserProgram(
      options(`return browser.js('Promise.resolve(42)');`, {
        sendCdp: async (method, params) => {
          expect(method).toBe('Runtime.evaluate');
          expect(params).toMatchObject({ awaitPromise: true, returnByValue: true });
          return { result: { value: 42 } };
        },
      }),
    );
    expect(success).toMatchObject({ status: 'exited', value: 42 });

    const failure = await runBrowserProgram(
      options(`return browser.js('missing.value');`, {
        sendCdp: async () => ({
          result: { subtype: 'error', description: 'ReferenceError: missing is not defined' },
          exceptionDetails: { lineNumber: 0, columnNumber: 0, text: 'Uncaught' },
        }),
      }),
    );
    expect(failure.status).toBe('failed');
    expect(failure.error?.message).toContain('JavaScript evaluation failed at line 0, column 0');
    expect(failure.error?.message).toContain('ReferenceError: missing is not defined');
  });

  it('captures stdout and stderr separately before returning', async () => {
    const result = await runBrowserProgram(
      options(`console.log('hello stdout'); console.error('hello stderr'); return 'done';`),
    );

    expect(result).toMatchObject({
      status: 'exited',
      value: 'done',
      stdout: 'hello stdout\n',
      stderr: 'hello stderr\n',
    });
  });

  it('returns a bounded structured error when the program throws', async () => {
    const result = await runBrowserProgram(
      options(`throw new TypeError('deliberate program failure');`),
    );

    expect(result.status).toBe('failed');
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({
      name: 'TypeError',
      message: 'deliberate program failure',
    });
    expect(result.error?.stack).toContain('sherlock-browser-program.js');
  });

  it('times out and terminates both the browser child and a descendant it spawned', async () => {
    const marker = join(cwd, 'timeout-descendant-marker.txt');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 400)`;
    const result = await runBrowserProgram(
      options(
        `
            const { spawn } = await import('node:child_process');
            spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
            await new Promise(() => {});
          `,
        { timeoutMs: 100 },
      ),
    );

    expect(result.status).toBe('timed_out');
    await wait(650);
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  it('returns cancelled when aborted and removes the abort listener', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const promise = runBrowserProgram(
      options(`await new Promise(() => {});`, { abortSignal: controller.signal }),
    );

    await wait(50);
    controller.abort();
    const result = await promise;

    expect(result.status).toBe('cancelled');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('hard-kills immediately and forces watchdog failure over cancellation', async () => {
    const readyPath = join(cwd, 'watchdog-failure-ready.txt');
    const controller = new AbortController();
    const controlledWatchdog = createControlledWatchdog();
    vi.spyOn(parentDeathWatchdogModule, 'startParentDeathWatchdog').mockResolvedValue(
      controlledWatchdog.watchdog,
    );
    const killSpy = vi.spyOn(process, 'kill');
    const promise = runBrowserProgram(
      options(
        `
            const fs = await import('node:fs');
            process.on('SIGTERM', () => {});
            fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
            await new Promise(() => {});
          `,
        { abortSignal: controller.signal },
      ),
    );

    try {
      await waitForPath(readyPath);
      controller.abort();
      const callsBeforeFailure = killSpy.mock.calls.length;

      controlledWatchdog.fail();

      expect(killSpy.mock.calls.slice(callsBeforeFailure)).toContainEqual([
        -controlledWatchdog.processGroupId(),
        'SIGKILL',
      ]);
      await expect(promise).resolves.toMatchObject({
        status: 'failed',
        error: {
          name: 'ParentDeathWatchdogError',
          message: 'parent-death watchdog stopped while its target was active',
        },
      });
    } finally {
      controller.abort();
      try {
        process.kill(-controlledWatchdog.processGroupId(), 'SIGKILL');
      } catch {
        // Production should already have removed the complete group.
      }
      await promise.catch(() => undefined);
    }
  }, 10_000);

  it('does not spawn at all for an already-aborted call', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendCdp = vi.fn(async () => ({}));

    const result = await runBrowserProgram(
      options(`throw new Error('must never execute');`, {
        abortSignal: controller.signal,
        sendCdp,
      }),
    );

    expect(result).toMatchObject({ status: 'cancelled', stdout: '', stderr: '' });
    expect(sendCdp).not.toHaveBeenCalled();
  });

  it('terminates and truncates capture when aggregate stdout/stderr exceeds its byte budget', async () => {
    const result = await runBrowserProgram(
      options(
        `process.stdout.write('a'.repeat(80)); process.stderr.write('b'.repeat(80)); await new Promise(() => {});`,
        { maxOutputBytes: 100 },
      ),
    );

    expect(result.status).toBe('output_limit_exceeded');
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      100,
    );
    expect(result.error?.name).toBe('OutputLimitError');
  });

  it('rejects an oversized child CDP request without forwarding it to the caller', async () => {
    const sendCdp = vi.fn(async () => ({}));
    const result = await runBrowserProgram(
      options(
        `return browser.cdp('Example.large', { data: 'x'.repeat(${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes}) });`,
        { sendCdp },
      ),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('IPC message exceeds');
    expect(sendCdp).not.toHaveBeenCalled();
  });

  it('turns an oversized CDP reply into a bounded child-visible failure', async () => {
    const result = await runBrowserProgram(
      options(`return browser.cdp('Example.largeReply');`, {
        sendCdp: async () => ({ data: 'x'.repeat(BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes) }),
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('CDP reply exceeds');
    expect(JSON.stringify(result)).not.toContain('x'.repeat(1_000));
  });

  it('classifies an oversized return value as output_limit_exceeded', async () => {
    const result = await runBrowserProgram(
      options(`return 'x'.repeat(${BROWSER_PROGRAM_LIMITS.maxResultBytes + 1});`),
    );

    expect(result.status).toBe('output_limit_exceeded');
    expect(result.error?.name).toBe('ResultLimitError');
    expect(result.value).toBeUndefined();
  });

  it('refuses oversized source before a child or CDP call is started', async () => {
    const sendCdp = vi.fn(async () => ({}));
    const result = await runBrowserProgram(
      options(' '.repeat(BROWSER_PROGRAM_LIMITS.maxSourceBytes + 1), { sendCdp }),
    );

    expect(result.status).toBe('protocol_error');
    expect(result.error?.message).toContain('source exceeds');
    expect(sendCdp).not.toHaveBeenCalled();
  });

  it('fails closed on direct malformed or oversized private-channel writes', async () => {
    const malformed = await runBrowserProgram(
      options(
        `process.send({ version: 1, kind: 'not-a-real-message' }); await new Promise(() => {});`,
      ),
    );
    const oversized = await runBrowserProgram(
      options(
        `process.send({
          version: 1,
          kind: 'not-a-real-message',
          data: 'x'.repeat(${BROWSER_PROGRAM_LIMITS.maxIpcMessageBytes})
        });
        await new Promise(() => {});`,
      ),
    );

    expect(malformed.status).toBe('protocol_error');
    expect(malformed.error?.message).toContain('unknown IPC message kind');
    expect(oversized.status).toBe('protocol_error');
    expect(oversized.error?.message).toContain('child IPC message exceeds');
  });

  it('uses only the sanitized caller environment and never ambient process.env', async () => {
    process.env.AMBIENT_ONLY = 'must-not-leak';
    try {
      const result = await runBrowserProgram(
        options(
          `return {
            safe: process.env.SAFE_SETTING ?? null,
            ambient: process.env.AMBIENT_ONLY ?? null,
            openai: process.env.OPENAI_API_KEY ?? null,
            browserbase: process.env.BROWSERBASE_API_KEY ?? null,
            attached: process.env.SHERLOCK_CHROME_CDP_ENDPOINT ?? null,
            nodeOptions: process.env.NODE_OPTIONS ?? null,
            cdp: process.env.CDP_URL ?? null
          };`,
          {
            env: {
              SAFE_SETTING: 'visible',
              OPENAI_API_KEY: 'openai-secret',
              BROWSERBASE_API_KEY: 'browserbase-secret',
              SHERLOCK_CHROME_CDP_ENDPOINT:
                'ws://127.0.0.1:61545/devtools/browser/attached-capability',
              NODE_OPTIONS: '--inspect=127.0.0.1:9333',
              CDP_URL: 'wss://secret.example/devtools/browser/capability',
            },
          },
        ),
      );

      expect(result).toMatchObject({
        status: 'exited',
        value: {
          safe: 'visible',
          ambient: null,
          openai: null,
          browserbase: null,
          attached: null,
          nodeOptions: null,
          cdp: null,
        },
      });
      expect(JSON.stringify(result)).not.toContain('openai-secret');
      expect(JSON.stringify(result)).not.toContain('capability');
    } finally {
      delete process.env.AMBIENT_ONLY;
    }
  });

  it('redacts a CDP capability if the parent sender throws one in an error', async () => {
    const result = await runBrowserProgram(
      options(`return browser.cdp('Example.fail');`, {
        sendCdp: async () => {
          throw new Error(
            'connect failed with retained detail: http://127.0.0.1:9222/json/version?token=session-control',
          );
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('connect failed with retained detail: [REDACTED_CDP_URL]');
    expect(JSON.stringify(result)).not.toContain('session-control');
  });

  it('cleans up background descendants even after a normal return', async () => {
    const marker = join(cwd, 'normal-descendant-marker.txt');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 400)`;
    const result = await runBrowserProgram(
      options(`
          const { spawn } = await import('node:child_process');
          spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
          return 'complete';
        `),
    );

    expect(result).toMatchObject({ status: 'exited', value: 'complete' });
    await wait(650);
    expect(existsSync(marker)).toBe(false);
  }, 10_000);
});
