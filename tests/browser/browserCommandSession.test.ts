import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, CDPSession, Page } from 'playwright';

import {
  openPlaywrightCommandSession,
  type BrowserTargetCommandPolicy,
} from '../../src/browser/browserCommandSession.js';
import type { BrowserController } from '../../src/browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import type { BrowserUploadEncoder, UploadPayload } from '../../src/browser/uploadEncoder.js';
import {
  createBusyResourceRegistry,
  EXCLUSIVE_ACCESS,
} from '../../src/tools/registry.js';
import { runBrowserProgram } from '../../src/tools/browserExecute/runner.js';

const TEST_TIMEOUT_MS = 15_000;
const PRIVATE_CONNECT_URL =
  'wss://connect.browserbase.com/v1/session?apiKey=definitely-secret';

async function waitForPages(
  controller: BrowserController,
  predicate: (pageIds: readonly string[]) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const pageIds = (await controller.pages()).map((page) => page.pageId);
    if (predicate(pageIds)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for browser pages; live pageIds: ${pageIds.join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function allowOwnedTargets(...initialTargetIds: string[]): BrowserTargetCommandPolicy {
  const targetIds = new Set(initialTargetIds);
  return {
    ownedTargetIds: async () => new Set(targetIds),
    createTarget: async (params, rawCreate) => {
      const result = await rawCreate(params);
      const targetId = (result as { targetId?: unknown })?.targetId;
      if (typeof targetId === 'string') targetIds.add(targetId);
      return result;
    },
  };
}

describe('PlaywrightBrowserController command sessions', () => {
  let controller: BrowserController;
  let profileDir: string;
  let testSequence = 0;

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'browser-command-session-chrome-'));
    controller = await new LocalChromeBrowserSessionProvider({
      profileDir,
      headless: true,
    }).createSession();
    controller.setBusyRegistry?.(createBusyResourceRegistry());
  }, 30_000);

  beforeEach(async () => {
    testSequence += 1;
    if (controller.prepareTaskPage === undefined) {
      throw new Error('Local controller omitted task-page preparation.');
    }
    await controller.prepareTaskPage({
      ownershipId: `browser-command-session-test-${testSequence}`,
    });
  });

  afterEach(async () => {
    await controller.closeTaskPages();
  });

  afterAll(async () => {
    await controller?.close();
    if (profileDir !== undefined) {
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    'pins selected and named sessions to their exact pages and executes arbitrary commands',
    async () => {
      const selectedPage = (await controller.pages()).find((page) => page.active);
      expect(selectedPage).toBeDefined();

      const selected = await controller.openCommandSession();
      expect(selected.pageId).toBe(selectedPage!.pageId);
      const navigation = await selected.navigate(
        'data:text/html,<title>Settled navigation</title><main>ready</main>',
        { timeoutMs: 5_000, waitUntil: 'domcontentloaded' },
      );
      expect(navigation).toMatchObject({
        pageId: selected.pageId,
        targetId: selected.targetId,
        title: 'Settled navigation',
      });
      expect(navigation.url).toContain('data:text/html');
      const selectedEvaluation = (await selected.send('Runtime.evaluate', {
        expression: "document.title = 'selected command target'; document.title",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      expect(selectedEvaluation.result?.value).toBe('selected command target');

      await selected.send('Runtime.evaluate', {
        expression: "window.open('about:blank', '_blank')",
      });
      await waitForPages(controller, (pageIds) => pageIds.length === 2);
      const namedPage = (await controller.pages()).find((page) => !page.active);
      expect(namedPage).toBeDefined();

      const named = await controller.openCommandSession(namedPage!.pageId);
      try {
        expect(named.pageId).toBe(namedPage!.pageId);
        expect(named.targetId).not.toBe(selected.targetId);
        const namedEvaluation = (await named.send('Runtime.evaluate', {
          expression: "document.title = 'named command target'; document.title",
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        expect(namedEvaluation.result?.value).toBe('named command target');
        const selectedTitle = (await selected.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        const namedTitle = (await named.send('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        expect(selectedTitle.result?.value).toBe('selected command target');
        expect(namedTitle.result?.value).toBe('named command target');
      } finally {
        await named.close();
        await selected.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails closed for a stale pageId instead of selecting another live page',
    async () => {
      const stale = await controller.openCommandSession();
      const stalePageId = stale.pageId;
      await stale.send('Page.close');
      await stale.close();
      await waitForPages(controller, (pageIds) => !pageIds.includes(stalePageId));

      await expect(controller.openCommandSession(stalePageId)).rejects.toThrow(
        `Unknown or closed browser pageId: ${stalePageId}`,
      );
      await expect(controller.openCommandSession()).rejects.toThrow(
        /No browser task page is active/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns no connection URL and rejects sends after an idempotent close',
    async () => {
      const session = await controller.openCommandSession();

      expect(Object.keys(session).sort()).toEqual([
        'close',
        'navigate',
        'pageId',
        'send',
        'targetId',
        'upload',
      ]);
      expect(JSON.stringify(session)).not.toMatch(/(?:wss?|https?):\/\//i);
      expect(JSON.stringify(session)).not.toContain(PRIVATE_CONNECT_URL);
      await session.close();
      await session.close();

      let message = '';
      try {
        await session.send('Runtime.evaluate', { expression: '1 + 1' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/command session.*closed/i);
      expect(message).not.toContain(PRIVATE_CONNECT_URL);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refreshes safe page inventory after external commands mutate the document',
    async () => {
      const before = (await controller.pages())[0];
      expect(before).toBeDefined();

      const mutate = await controller.openCommandSession();
      await mutate.send('Runtime.evaluate', {
        expression:
          "document.body.innerHTML = '<button>After</button>'; " +
          "history.replaceState(null, '', 'about:blank#after'); location.href",
      });
      await mutate.close();
      await controller.refreshAfterExternalCommands();

      expect(await controller.pages()).toEqual([
        {
          pageId: before!.pageId,
          url: 'about:blank#after',
          active: true,
        },
      ]);
      expect(controller.currentUrl()).toBe('about:blank#after');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'restores a usable owned page when commands close the selected page',
    async () => {
      const session = await controller.openCommandSession();
      await session.send('Page.close');
      await session.close();

      await controller.refreshAfterExternalCommands();

      expect(await controller.pages()).toEqual([
        expect.objectContaining({ active: true, url: 'about:blank' }),
      ]);
      expect(controller.currentUrl()).toBe('about:blank');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('command-session transport boundary', () => {
  function fakeTarget(options: {
    commandError?: Error;
  } = {}): {
    context: BrowserContext;
    page: Page;
    goto: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  } {
    const goto = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      goto,
      url: () => 'https://example.test/settled',
      title: vi.fn(async () => 'Settled title'),
    } as unknown as Page;
    const send = vi.fn(async (method: string) => {
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'target-exact' } };
      }
      if (options.commandError !== undefined) throw options.commandError;
      return { ok: true };
    });
    const detach = vi.fn(async () => undefined);
    const cdp = { send, detach } as unknown as CDPSession;
    const context = {
      newCDPSession: vi.fn(async (attachedPage: Page) => {
        expect(attachedPage).toBe(page);
        return cdp;
      }),
    } as unknown as BrowserContext;
    return { context, page, goto, send, detach };
  }

  it('detaches exactly once, rejects later sends, and retains only safe identity', async () => {
    const { context, page, goto, send, detach } = fakeTarget();
    const session = await openPlaywrightCommandSession(context, page, 'page-exact', {
      targetPolicy: allowOwnedTargets('target-exact'),
    });

    expect(session.pageId).toBe('page-exact');
    expect(session.targetId).toBe('target-exact');
    expect(await session.send('Experimental.command', { enabled: true })).toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith('Experimental.command', { enabled: true });
    await expect(
      session.navigate('https://example.test/settled', {
        timeoutMs: 2_500,
        waitUntil: 'load',
      }),
    ).resolves.toEqual({
      pageId: 'page-exact',
      targetId: 'target-exact',
      url: 'https://example.test/settled',
      title: 'Settled title',
    });
    expect(goto).toHaveBeenCalledExactlyOnceWith(
      'https://example.test/settled',
      { timeout: 2_500, waitUntil: 'load' },
    );

    await session.close();
    await session.close();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(session.send('Runtime.evaluate')).rejects.toThrow(/closed/i);
  });

  it('filters target inventory and refuses ambient or non-whitelisted target commands', async () => {
    const targetInfos = [
      {
        targetId: 'target-exact',
        type: 'page',
        title: 'Owned main',
        url: 'about:blank#owned-main',
      },
      {
        targetId: 'target-owned-popup',
        type: 'page',
        title: 'Owned popup',
        url: 'about:blank#owned-popup',
      },
      {
        targetId: 'target-ambient-secret',
        type: 'page',
        title: 'Ambient secret title',
        url: 'https://ambient.example.test/private',
      },
    ];
    const send = vi.fn(
      async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Target.getTargets') return { targetInfos };
        if (method === 'Target.getTargetInfo') {
          const requested =
            typeof params.targetId === 'string' ? params.targetId : 'target-exact';
          return {
            targetInfo: targetInfos.find((target) => target.targetId === requested),
          };
        }
        if (method === 'Target.activateTarget') return {};
        if (method === 'Target.closeTarget') return { success: true };
        throw new Error(`unexpected raw command ${method}`);
      },
    );
    const detach = vi.fn(async () => undefined);
    const page = { isClosed: () => false } as unknown as Page;
    const context = {
      newCDPSession: vi.fn(async () => ({ send, detach })),
    } as unknown as BrowserContext;
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-exact',
      {
        targetPolicy: allowOwnedTargets(
          'target-exact',
          'target-owned-popup',
        ),
      },
    );

    expect(await session.send('Target.getTargets')).toEqual({
      targetInfos: targetInfos.slice(0, 2),
    });
    expect(await session.send('Target.getTargetInfo')).toEqual({
      targetInfo: targetInfos[0],
    });
    expect(
      await session.send('Target.getTargetInfo', {
        targetId: 'target-owned-popup',
      }),
    ).toEqual({ targetInfo: targetInfos[1] });
    await expect(
      session.send('Target.activateTarget', {
        targetId: 'target-owned-popup',
      }),
    ).resolves.toEqual({});
    await expect(
      session.send('Target.closeTarget', {
        targetId: 'target-owned-popup',
      }),
    ).resolves.toEqual({ success: true });

    for (const [method, params] of [
      ['Target.getTargetInfo', { targetId: 'target-ambient-secret' }],
      ['Target.activateTarget', { targetId: 'target-ambient-secret' }],
      ['Target.closeTarget', { targetId: 'target-ambient-secret' }],
      ['Target.attachToTarget', { targetId: 'target-ambient-secret', flatten: true }],
      ['Target.setDiscoverTargets', { discover: true }],
      ['Browser.close', {}],
      ['Browser.crash', {}],
      ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
    ] as const) {
      const callsBefore = send.mock.calls.length;
      let message = '';
      try {
        await session.send(method, params);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/not allowed|outside this run/i);
      expect(message).not.toContain('target-ambient-secret');
      expect(send).toHaveBeenCalledTimes(callsBefore);
    }

    await session.close();
  });

  it('redacts a provider connection URL from command errors', async () => {
    const { context, page } = fakeTarget({
      commandError: new Error(`transport failed at ${PRIVATE_CONNECT_URL}`),
    });
    const session = await openPlaywrightCommandSession(context, page, 'page-safe', {
      targetPolicy: allowOwnedTargets('target-exact'),
    });

    let message = '';
    try {
      await session.send('Runtime.evaluate');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      await session.close();
    }
    expect(message).toContain('[redacted URL]');
    expect(message).not.toContain(PRIVATE_CONNECT_URL);
  });

  it('encodes a remote upload as bytes, targets the exact backend node, and cleans its marker', async () => {
    const setInputFiles = vi.fn(async () => undefined);
    const locator = {
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => true),
      setInputFiles,
    };
    const page = {
      isClosed: () => false,
      frames: () => [{ locator: vi.fn(() => locator) }],
    } as unknown as Page;
    const send = vi.fn(async (method: string) => {
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'target-exact' } };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'upload-object' } };
      }
      return {};
    });
    const detach = vi.fn(async () => undefined);
    const context = {
      newCDPSession: vi.fn(async () => ({ send, detach })),
    } as unknown as BrowserContext;
    const payload: UploadPayload = {
      name: 'evidence.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name\nAda\n'),
    };
    const uploadEncoder: BrowserUploadEncoder = {
      encode: vi.fn(async () => [payload]),
    };
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-exact',
      {
        targetPolicy: allowOwnedTargets('target-exact'),
        uploadEncoder,
      },
    );

    await session.upload(73, '/confined/workspace/evidence.csv');

    expect(uploadEncoder.encode).toHaveBeenCalledExactlyOnceWith([
      '/confined/workspace/evidence.csv',
    ]);
    expect(send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 73 });
    expect(setInputFiles).toHaveBeenCalledExactlyOnceWith(
      [payload],
      { timeout: 5_000 },
    );
    expect(
      send.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn'),
    ).toHaveLength(2);
    expect(send).toHaveBeenCalledWith('Runtime.releaseObject', {
      objectId: 'upload-object',
    });
    await session.close();
  });

  it('fences and drains an upload that outlives the browser-program timeout', async () => {
    let releaseEncoding!: () => void;
    const encodingGate = new Promise<void>((resolve) => {
      releaseEncoding = resolve;
    });
    const payload: UploadPayload = {
      name: 'late.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name\nLate\n'),
    };
    const uploadEncoder: BrowserUploadEncoder = {
      encode: vi.fn(async () => {
        await encodingGate;
        return [payload];
      }),
    };
    const setInputFiles = vi.fn(async () => undefined);
    const page = {
      isClosed: () => false,
      frames: () => [
        {
          locator: vi.fn(() => ({
            count: vi.fn(async () => 1),
            evaluate: vi.fn(async () => true),
            setInputFiles,
          })),
        },
      ],
    } as unknown as Page;
    const send = vi.fn(async (method: string) => {
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'target-late' } };
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'late-upload-object' } };
      }
      return {};
    });
    const detach = vi.fn(async () => undefined);
    const context = {
      newCDPSession: vi.fn(async () => ({ send, detach })),
    } as unknown as BrowserContext;
    const busyRegistry = createBusyResourceRegistry();
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-late',
      {
        targetPolicy: allowOwnedTargets('target-late'),
        uploadEncoder,
        trackUploadEffect: (effect) =>
          busyRegistry.markAbandoned(EXCLUSIVE_ACCESS, effect),
      },
    );

    const program = runBrowserProgram({
      code: `await browser.upload(91, 'late.csv');`,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      page: { pageId: session.pageId, targetId: session.targetId },
      timeoutMs: 1_000,
      maxOutputBytes: 1_000_000,
      sendCdp: (method, params) => session.send(method, params),
      navigate: (url, options) => session.navigate(url, options),
      upload: (backendDOMNodeId, workspacePath) =>
        session.upload(backendDOMNodeId, `/confined/${workspacePath}`),
    });
    await vi.waitFor(() => expect(uploadEncoder.encode).toHaveBeenCalledOnce());
    const result = await program;

    expect(result.status).toBe('timed_out');
    expect(uploadEncoder.encode).toHaveBeenCalledExactlyOnceWith([
      '/confined/late.csv',
    ]);
    await expect(
      busyRegistry.waitUntilFree(EXCLUSIVE_ACCESS, 10),
    ).resolves.toBe(false);

    let closeSettled = false;
    const close = session.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(detach).not.toHaveBeenCalled();

    releaseEncoding();
    await close;

    expect(setInputFiles).toHaveBeenCalledExactlyOnceWith(
      [payload],
      { timeout: 5_000 },
    );
    expect(detach).toHaveBeenCalledOnce();
    await expect(
      busyRegistry.waitUntilFree(EXCLUSIVE_ACCESS, 100),
    ).resolves.toBe(true);
  });

  it('reports only an exact successful Target.createTarget result to the ownership hook', async () => {
    const { context, page, send } = fakeTarget();
    const targetPolicy = allowOwnedTargets('target-exact');
    const createTarget = vi.spyOn(targetPolicy, 'createTarget');
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-safe',
      { targetPolicy },
    );
    send.mockResolvedValueOnce({ targetId: 'target-created-by-run' });

    expect(
      await session.send('Target.createTarget', { url: 'about:blank' }),
    ).toEqual({ targetId: 'target-created-by-run' });
    await session.send('Runtime.evaluate', { expression: '1' });

    expect(createTarget).toHaveBeenCalledOnce();
    expect(await targetPolicy.ownedTargetIds()).toContain('target-created-by-run');
    await session.close();
  });

  it('routes dialog decisions through controller-owned pending state', async () => {
    const { context, page, send } = fakeTarget();
    const handleDialogCommand = vi.fn(async () => ({ handled: true }));
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-safe',
      {
        targetPolicy: allowOwnedTargets('target-exact'),
        handleDialogCommand,
      },
    );

    await session.send('Runtime.evaluate', { expression: '1' });
    expect(handleDialogCommand).not.toHaveBeenCalled();
    await expect(
      session.send('Page.handleJavaScriptDialog', { accept: false }),
    ).resolves.toEqual({ handled: true });
    expect(handleDialogCommand).toHaveBeenCalledExactlyOnceWith({ accept: false });
    expect(send).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: false,
    });
    await session.close();
  });

  it('can transfer one idempotent detach capability to controller ownership', async () => {
    const { context, page, detach } = fakeTarget();
    let transferred: (() => Promise<void>) | undefined;
    const release = vi.fn(async (detachSession: () => Promise<void>) => {
      transferred = detachSession;
    });
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-safe',
      {
        targetPolicy: allowOwnedTargets('target-exact'),
        release,
      },
    );

    await session.close();
    await session.close();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.any(Function), false);
    expect(detach).not.toHaveBeenCalled();

    await transferred?.();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('reports an abandoned raw command when closing without awaiting it', async () => {
    const { context, page, send, detach } = fakeTarget();
    send.mockImplementation(async (method: string) => {
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: 'target-exact' } };
      }
      await new Promise<never>(() => undefined);
    });
    const release = vi.fn(
      async (
        detachSession: () => Promise<void>,
        hadPendingCommands: boolean,
      ) => {
        expect(hadPendingCommands).toBe(true);
        await detachSession();
      },
    );
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-busy',
      {
        targetPolicy: allowOwnedTargets('target-exact'),
        release,
      },
    );

    void session.send('Runtime.evaluate', {
      expression: 'while (true) {}',
    }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: 'while (true) {}',
      }),
    );

    await session.close();

    expect(release).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      true,
    );
    expect(detach).toHaveBeenCalledOnce();
  });
});
