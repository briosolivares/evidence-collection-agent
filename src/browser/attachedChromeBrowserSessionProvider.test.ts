import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Frame, Page } from 'playwright';

import {
  AttachedChromeBrowserSessionProvider,
  type AttachedChromeBrowserSessionOptions,
} from './attachedChromeBrowserSessionProvider.js';

const ENDPOINT = 'http://127.0.0.1:9222';

function fakePage(url: string): {
  page: Page;
  close: ReturnType<typeof vi.fn>;
} {
  let closed = false;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const frame = {
    url: () => url,
    isDetached: () => false,
  } as unknown as Frame;
  const close = vi.fn(async () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners.get('close') ?? []) listener();
  });
  const page = {
    url: () => url,
    title: vi.fn(async () => url),
    isClosed: () => closed,
    frames: () => [frame],
    mainFrame: () => frame,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
    }),
    close,
  } as unknown as Page;
  return { page, close };
}

function fakeContext(preexistingPages: Page[] = []): {
  context: BrowserContext;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  taskPages: Page[];
} {
  const pageListeners: Array<(page: Page) => void> = [];
  const allPages = [...preexistingPages];
  const taskPages: Page[] = [];
  const targetIds = new WeakMap<Page, string>();
  let targetSequence = 0;
  const targetIdFor = (page: Page): string => {
    let targetId = targetIds.get(page);
    if (targetId === undefined) {
      targetSequence += 1;
      targetId = `fake-target-${targetSequence}`;
      targetIds.set(page, targetId);
    }
    return targetId;
  };
  const close = vi.fn(async () => undefined);
  const newPage = vi.fn(async () => {
    const taskPage = fakePage(`about:blank#task-${taskPages.length + 1}`).page;
    taskPages.push(taskPage);
    allPages.push(taskPage);
    for (const listener of pageListeners) listener(taskPage);
    return taskPage;
  });
  const context = {
    on: vi.fn((event: string, listener: (page: Page) => void) => {
      if (event === 'page') pageListeners.push(listener);
    }),
    pages: vi.fn(() => [...allPages]),
    newPage,
    newCDPSession: vi.fn(async (page: Page) => ({
      send: vi.fn(async (method: string) => {
        if (method !== 'Target.getTargetInfo') return {};
        return {
          targetInfo: {
            targetId: targetIdFor(page),
            type: 'page',
            title: '',
            url: page.url(),
            attached: true,
            browserContextId: 'fake-attached-context',
          },
        };
      }),
      detach: vi.fn(async () => undefined),
    })),
    close,
    isClosed: () => false,
    browser: () => ({ isConnected: () => true }),
  } as unknown as BrowserContext;
  return { context, close, newPage, taskPages };
}

function fakeBrowser(contexts: BrowserContext[]): {
  browser: Browser;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(async () => undefined);
  const browser = {
    contexts: vi.fn(() => contexts),
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === 'Target.getBrowserContexts'
          ? { browserContextIds: [] }
          : {},
      ),
      detach: vi.fn(async () => undefined),
    })),
    close,
    isConnected: () => true,
  } as unknown as Browser;
  return { browser, close };
}

function provider(
  browser: Browser,
  overrides: Partial<AttachedChromeBrowserSessionOptions> = {},
): AttachedChromeBrowserSessionProvider {
  return new AttachedChromeBrowserSessionProvider({
    cdpEndpoint: ENDPOINT,
    connectOverCDP: async () => browser,
    ...overrides,
  });
}

describe('AttachedChromeBrowserSessionProvider endpoint boundary', () => {
  it.each([
    'not a URL',
    'https://127.0.0.1:9222',
    'ws://127.0.0.1:9222/devtools/browser/secret',
    'http://example.com:9222',
  ])('rejects %s before attempting a connection and redacts it', (cdpEndpoint) => {
    const connectOverCDP = vi.fn(async () => fakeBrowser([]).browser);
    let message = '';

    try {
      new AttachedChromeBrowserSessionProvider({ cdpEndpoint, connectOverCDP });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(cdpEndpoint);
    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  it.each(['http://127.0.0.1:9222', 'http://localhost:9333/'])(
    'connects to an accepted loopback HTTP endpoint unchanged: %s',
    async (cdpEndpoint) => {
      const { context } = fakeContext();
      const { browser } = fakeBrowser([context]);
      const connectOverCDP = vi.fn(async () => browser);
      const attached = new AttachedChromeBrowserSessionProvider({
        cdpEndpoint,
        connectOverCDP,
      });

      await attached.createSession();

      expect(connectOverCDP).toHaveBeenCalledExactlyOnceWith(cdpEndpoint);
    },
  );

  it('redacts connection errors and does not retain the original as a cause', async () => {
    const secretEndpoint = `${ENDPOINT}/?token=do-not-print-me`;
    const attached = new AttachedChromeBrowserSessionProvider({
      cdpEndpoint: secretEndpoint,
      connectOverCDP: async () => {
        throw new Error(`connect ECONNREFUSED ${secretEndpoint}`);
      },
    });

    let thrown: unknown;
    try {
      await attached.createSession();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secretEndpoint);
    expect((thrown as Error).message).not.toContain('do-not-print-me');
    expect((thrown as Error).cause).toBeUndefined();
  });
});

describe('AttachedChromeBrowserSessionProvider page ownership', () => {
  it('opens one fresh owned task page and excludes every pre-existing page after refresh', async () => {
    const first = fakePage('https://mail.example.test/');
    const second = fakePage('https://calendar.example.test/');
    const { context, newPage, taskPages } = fakeContext([first.page, second.page]);
    const { browser } = fakeBrowser([context]);
    const controller = await provider(browser).createSession();

    expect(newPage).not.toHaveBeenCalled();
    expect(await controller.pages()).toEqual([]);

    await controller.newTab();
    await controller.refreshAfterExternalCommands();

    expect(newPage).toHaveBeenCalledOnce();
    expect(taskPages).toHaveLength(1);
    const visiblePages = await controller.pages();
    expect(visiblePages).toHaveLength(1);
    expect(visiblePages[0]?.url).toBe('about:blank#task-1');
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('disconnects once without closing the existing context or any user page', async () => {
    const first = fakePage('https://mail.example.test/');
    const second = fakePage('https://calendar.example.test/');
    const { context, close: closeContext } = fakeContext([
      first.page,
      second.page,
    ]);
    const { browser, close: disconnectClient } = fakeBrowser([context]);
    const controller = await provider(browser).createSession();

    await controller.close();
    await controller.close();

    expect(disconnectClient).toHaveBeenCalledTimes(1);
    expect(closeContext).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('returns local diagnostics containing no endpoint or connection capability', async () => {
    const secretEndpoint = `${ENDPOINT}/?token=diagnostic-secret`;
    const { context } = fakeContext();
    const { browser } = fakeBrowser([context]);
    const controller = await provider(browser, { cdpEndpoint: secretEndpoint }).createSession();

    expect(controller.sessionDiagnostics).toEqual({ provider: 'local' });
    expect(JSON.stringify(controller.sessionDiagnostics)).not.toContain(secretEndpoint);
    expect(JSON.stringify(controller.sessionDiagnostics)).not.toContain('diagnostic-secret');
    expect(controller.prepareForBrowserScript).toBeUndefined();
  });
});

describe('AttachedChromeBrowserSessionProvider initialization cleanup', () => {
  it.each([
    { label: 'zero', count: 0, expected: /no browser context/i },
    { label: 'multiple', count: 2, expected: /2 browser contexts/i },
  ])('rejects $label contexts explicitly and disconnects once', async ({ count, expected }) => {
    const contexts = Array.from({ length: count }, () => fakeContext().context);
    const { browser, close } = fakeBrowser(contexts);
    const attached = provider(browser);

    await expect(attached.createSession()).rejects.toThrow(expected);
    expect(close).toHaveBeenCalledTimes(1);
    for (const context of contexts) {
      expect(context.close).not.toHaveBeenCalled();
    }
  });

  it('disconnects after a later setup error and redacts error and cleanup details', async () => {
    const secretEndpoint = `${ENDPOINT}/?token=setup-secret`;
    const { context } = fakeContext();
    vi.mocked(context.pages).mockImplementation(() => {
      throw new Error(`page enumeration failed at ${secretEndpoint}`);
    });
    const { browser, close } = fakeBrowser([context]);
    close.mockRejectedValue(new Error(`disconnect failed at ${secretEndpoint}`));
    const attached = provider(browser, { cdpEndpoint: secretEndpoint });

    let message = '';
    try {
      await attached.createSession();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/initialize/i);
    expect(message).toMatch(/cleanup/i);
    expect(message).not.toContain(secretEndpoint);
    expect(message).not.toContain('setup-secret');
  });
});
