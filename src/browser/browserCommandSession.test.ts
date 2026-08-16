import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, CDPSession, Page } from 'playwright';

import { openPlaywrightCommandSession } from './browserCommandSession.js';
import type { BrowserController } from './controller.js';
import { LocalChromeBrowserSessionProvider } from './playwrightBrowserController.js';

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

describe('PlaywrightBrowserController command sessions', () => {
  let controller: BrowserController;
  let profileDir: string;

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'browser-command-session-chrome-'));
    controller = await new LocalChromeBrowserSessionProvider({
      profileDir,
      headless: true,
    }).createSession();
  }, 30_000);

  beforeEach(async () => {
    await controller.newTab();
  });

  afterEach(async () => {
    // A test may create a non-selected target. Close every such page through
    // the command-session seam itself so later tests start from one task tab.
    for (const page of await controller.pages()) {
      if (page.active) continue;
      const session = await controller.openCommandSession(page.pageId);
      try {
        await session.send('Page.close').catch(() => undefined);
      } finally {
        await session.close();
      }
    }
    await controller.closeTab();
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
        expect(await controller.title(selected.pageId)).toBe('selected command target');
        expect(await controller.title(named.pageId)).toBe('named command target');
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
        /No browser task tab is active/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns no connection URL and rejects sends after an idempotent close',
    async () => {
      const session = await controller.openCommandSession();

      expect(Object.keys(session).sort()).toEqual(['close', 'pageId', 'send', 'targetId']);
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
    'invalidates observations after external commands mutate the document',
    async () => {
      const seed = await controller.openCommandSession();
      await seed.send('Runtime.evaluate', {
        expression: "document.body.innerHTML = '<button>Before</button>'",
      });
      await seed.close();
      await controller.refreshAfterExternalCommands();
      const before = await controller.observe();

      const mutate = await controller.openCommandSession();
      await mutate.send('Runtime.evaluate', {
        expression: "document.body.innerHTML = '<button>After</button>'",
      });
      await mutate.close();
      await controller.refreshAfterExternalCommands();

      const after = await controller.observe({
        basedOnObservationId: before.page.observationId,
      });
      expect(after.page.documentId).not.toBe(before.page.documentId);
      expect(after.changes.basis).toBe('full_snapshot');
      expect(after.views[0]?.content).toContain('After');
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
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  } {
    const page = { isClosed: () => false } as unknown as Page;
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
    return { context, page, send, detach };
  }

  it('detaches exactly once, rejects later sends, and retains only safe identity', async () => {
    const { context, page, send, detach } = fakeTarget();
    const session = await openPlaywrightCommandSession(context, page, 'page-exact');

    expect(session.pageId).toBe('page-exact');
    expect(session.targetId).toBe('target-exact');
    expect(await session.send('Experimental.command', { enabled: true })).toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith('Experimental.command', { enabled: true });

    await session.close();
    await session.close();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(session.send('Runtime.evaluate')).rejects.toThrow(/closed/i);
  });

  it('redacts a provider connection URL from command errors', async () => {
    const { context, page } = fakeTarget({
      commandError: new Error(`transport failed at ${PRIVATE_CONNECT_URL}`),
    });
    const session = await openPlaywrightCommandSession(context, page, 'page-safe');

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

  it('reports only an exact successful Target.createTarget result to the ownership hook', async () => {
    const { context, page, send } = fakeTarget();
    const onTargetCreated = vi.fn(async () => undefined);
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-safe',
      { onTargetCreated },
    );
    send.mockResolvedValueOnce({ targetId: 'target-created-by-run' });

    expect(
      await session.send('Target.createTarget', { url: 'about:blank' }),
    ).toEqual({ targetId: 'target-created-by-run' });
    await session.send('Runtime.evaluate', { expression: '1' });

    expect(onTargetCreated).toHaveBeenCalledExactlyOnceWith(
      'target-created-by-run',
    );
    await session.close();
  });

  it('routes dialog decisions through controller-owned pending state', async () => {
    const { context, page, send } = fakeTarget();
    const handleDialogCommand = vi.fn(async () => ({ handled: true }));
    const session = await openPlaywrightCommandSession(
      context,
      page,
      'page-safe',
      { handleDialogCommand },
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
      { release },
    );

    await session.close();
    await session.close();
    expect(release).toHaveBeenCalledOnce();
    expect(detach).not.toHaveBeenCalled();

    await transferred?.();
    expect(detach).toHaveBeenCalledOnce();
  });
});
