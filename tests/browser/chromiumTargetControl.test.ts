import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChromiumTargetControlError,
  createChromiumTargetControl,
  type ChromiumPageTargetRef,
} from '../../src/browser/chromiumTargetControl.js';

interface FakeTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}

interface CdpRequest {
  method: string;
  params: Record<string, unknown> | undefined;
  attachedPage: Page;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakePage(): Page {
  let closed = false;
  return {
    isClosed: () => closed,
    close: vi.fn(async () => {
      closed = true;
    }),
  } as unknown as Page;
}

function targetInfo(
  targetId: string,
  browserContextId: string | undefined,
  overrides: Partial<FakeTargetInfo> = {},
): FakeTargetInfo {
  return {
    targetId,
    type: 'page',
    title: '',
    url: 'about:blank',
    attached: true,
    ...(browserContextId === undefined ? {} : { browserContextId }),
    ...overrides,
  };
}

function fakeChromium(options: { browserContextId?: string } = {}) {
  const browserContextId = options.browserContextId;
  const anchorPage = fakePage();
  const pages: Page[] = [anchorPage];
  const pageTargetIds = new Map<Page, string>([[anchorPage, 'target-anchor']]);
  const targets = new Map<string, FakeTargetInfo>([
    ['target-anchor', targetInfo('target-anchor', browserContextId)],
  ]);
  const pageListeners = new Set<(page: Page) => void>();
  const detachCalls: Array<ReturnType<typeof vi.fn>> = [];
  let createSequence = 0;
  let intercept: ((request: CdpRequest) => Promise<unknown> | undefined) | undefined;

  const send = vi.fn(
    async (
      attachedPage: Page,
      method: string,
      params: Record<string, unknown> | undefined,
    ): Promise<unknown> => {
      const intercepted = intercept?.({ method, params, attachedPage });
      if (intercepted !== undefined) return intercepted;

      if (method === 'Target.getTargets') {
        return { targetInfos: [...targets.values()] };
      }
      if (method === 'Target.getTargetInfo') {
        const targetId =
          typeof params?.targetId === 'string' ? params.targetId : pageTargetIds.get(attachedPage);
        const info = targetId === undefined ? undefined : targets.get(targetId);
        if (info === undefined) throw new Error('No such fake target');
        return { targetInfo: info };
      }
      if (method === 'Target.createTarget') {
        createSequence += 1;
        const targetId = `target-created-${createSequence}`;
        targets.set(
          targetId,
          targetInfo(targetId, browserContextId, {
            url: typeof params?.url === 'string' ? params.url : '',
          }),
        );
        return { targetId };
      }
      if (method === 'Target.closeTarget') {
        const targetId = params?.targetId;
        if (typeof targetId !== 'string') return { success: false };
        return { success: targets.delete(targetId) };
      }
      throw new Error(`Unexpected fake CDP method ${method}`);
    },
  );

  const newCDPSession = vi.fn(async (attachedPage: Page): Promise<CDPSession> => {
    const detach = vi.fn(async () => undefined);
    detachCalls.push(detach);
    return {
      send: (method: string, params?: Record<string, unknown>) =>
        send(attachedPage, method, params),
      detach,
    } as unknown as CDPSession;
  });

  const context = {
    pages: () => [...pages],
    newCDPSession,
    on: (event: string, listener: (page: Page) => void) => {
      if (event === 'page') pageListeners.add(listener);
    },
    off: (event: string, listener: (page: Page) => void) => {
      if (event === 'page') pageListeners.delete(listener);
    },
  } as unknown as BrowserContext;

  return {
    anchorPage,
    browserContextId,
    context,
    detachCalls,
    newCDPSession,
    pageListeners,
    send,
    targets,
    addTarget(id: string, contextId = browserContextId, overrides: Partial<FakeTargetInfo> = {}) {
      targets.set(id, targetInfo(id, contextId, overrides));
    },
    addPage(id: string, emit = true): Page {
      const page = fakePage();
      pages.push(page);
      pageTargetIds.set(page, id);
      if (emit) {
        for (const listener of [...pageListeners]) listener(page);
      }
      return page;
    },
    setIntercept(next: typeof intercept) {
      intercept = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Chromium target control', () => {
  it('binds through a browser-scoped CDP session without creating an anchor page', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    const detach = vi.fn(async () => undefined);
    const browser = {
      contexts: () => [fake.context],
      newBrowserCDPSession: vi.fn(async () => ({
        send: (method: string, params?: Record<string, unknown>) =>
          fake.send(fake.anchorPage, method, params),
        detach,
      })),
    } as unknown as Browser;

    const control = await createChromiumTargetControl({
      context: fake.context,
      browser,
    });

    await expect(control.listPageTargets()).resolves.toHaveLength(1);
    expect(browser.newBrowserCDPSession).toHaveBeenCalledOnce();
    expect((fake.context as unknown as { newPage?: unknown }).newPage).toBeUndefined();
    await control.close();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('lists, creates, and closes exact page targets only inside the anchor context', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    fake.addTarget('target-same-context');
    fake.addTarget('target-other-context', 'context-b');
    fake.addTarget('target-worker', 'context-a', { type: 'service_worker' });

    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });

    const listed = await control.listPageTargets();
    expect(listed).toHaveLength(2);
    expect(listed.map((target) => target.url)).toEqual(['about:blank', 'about:blank']);

    const created = await control.createPageTarget('about:blank#task-sentinel');
    expect(Object.keys(created)).toEqual([]);
    expect(JSON.stringify(created)).toBe('{}');
    expect(fake.send).toHaveBeenCalledWith(fake.anchorPage, 'Target.createTarget', {
      url: 'about:blank#task-sentinel',
      browserContextId: 'context-a',
    });

    await control.closeTarget(created);
    expect(fake.send).toHaveBeenCalledWith(fake.anchorPage, 'Target.closeTarget', {
      targetId: 'target-created-1',
    });
    expect(fake.targets.has('target-created-1')).toBe(false);

    await control.close();
    await control.close();
    expect(fake.detachCalls[0]).toHaveBeenCalledOnce();
  });

  it('omits browserContextId when Chromium reports the default context', async () => {
    const fake = fakeChromium();
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });

    await control.createPageTarget('about:blank');
    expect(fake.send).toHaveBeenCalledWith(fake.anchorPage, 'Target.createTarget', {
      url: 'about:blank',
    });
    await control.close();
  });

  it('retries one transient read-only target inventory rejection', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    let inventories = 0;
    fake.setIntercept(({ method }) => {
      if (method !== 'Target.getTargets') return undefined;
      inventories += 1;
      return inventories === 1
        ? Promise.reject(new Error('transient attached-session detach'))
        : undefined;
    });
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });

    await expect(control.listPageTargets()).resolves.toHaveLength(1);
    expect(inventories).toBe(2);
    await control.close();
  });

  it('rejects a target ref from another control before sending a close command', async () => {
    const first = fakeChromium({ browserContextId: 'context-a' });
    const second = fakeChromium({ browserContextId: 'context-b' });
    const firstControl = await createChromiumTargetControl({
      context: first.context,
      anchorPage: first.anchorPage,
    });
    const secondControl = await createChromiumTargetControl({
      context: second.context,
      anchorPage: second.anchorPage,
    });
    const foreign = (await firstControl.listPageTargets())[0]!.ref;
    const sendsBefore = second.send.mock.calls.length;

    await expect(secondControl.closeTarget(foreign)).rejects.toThrow(/not issued by this control/);
    expect(second.send).toHaveBeenCalledTimes(sendsBefore);

    await Promise.all([firstControl.close(), secondControl.close()]);
  });

  it('awaits the exact Playwright Page while ignoring other pages in the context', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    fake.addTarget('target-wrong');
    fake.addTarget('target-exact');
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });
    const refs = await control.listPageTargets();
    const exactRef = refs[2]!.ref;

    const awaiting = control.awaitPage(exactRef);
    fake.addPage('target-wrong');
    const exactPage = fake.addPage('target-exact');

    await expect(awaiting).resolves.toBe(exactPage);
    expect(fake.pageListeners).toHaveLength(0);
    await control.close();
  });

  it('removes its page listener and preserves the exact abort reason', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    fake.addTarget('target-never-surfaced');
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });
    const target = (await control.listPageTargets())[1]!.ref;
    const abort = new AbortController();
    const reason = new Error('stop this run');
    const awaiting = control.awaitPage(target, { signal: abort.signal });

    abort.abort(reason);

    await expect(awaiting).rejects.toBe(reason);
    expect(fake.pageListeners).toHaveLength(0);
    await control.close();
  });

  it('has an internal deadline even when the caller supplies no signal', async () => {
    const fake = fakeChromium();
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
      operationTimeoutMs: 25,
    });
    fake.setIntercept(({ method }) =>
      method === 'Target.getTargets' ? new Promise<never>(() => undefined) : undefined,
    );
    vi.useFakeTimers();

    const listing = control.listPageTargets();
    const rejection = expect(listing).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    vi.useRealTimers();
    await control.close();
  });

  it('closes an exact target whose create response arrives after cancellation', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    const lateCreate = deferred<unknown>();
    fake.setIntercept(({ method }) =>
      method === 'Target.createTarget' ? lateCreate.promise : undefined,
    );
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });
    const abort = new AbortController();
    const reason = new Error('wall deadline');
    const creation = control.createPageTarget('about:blank#late', {
      signal: abort.signal,
    });

    abort.abort(reason);
    await expect(creation).rejects.toBe(reason);

    let drained = false;
    const containment = control.drainContainment().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    fake.addTarget('target-created-late', 'context-a', { url: 'about:blank#late' });
    lateCreate.resolve({ targetId: 'target-created-late' });
    await containment;
    expect(drained).toBe(true);
    expect(fake.targets.has('target-created-late')).toBe(false);
    expect(fake.send).toHaveBeenCalledWith(fake.anchorPage, 'Target.closeTarget', {
      targetId: 'target-created-late',
    });
    await control.close();
  });

  it('awaits the crash hook immediately after minting the opaque create ref', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    const hookEntered = deferred<ChromiumPageTargetRef>();
    const releaseHook = deferred<void>();
    const afterTargetCreated = vi.fn(async (target: ChromiumPageTargetRef) => {
      hookEntered.resolve(target);
      await releaseHook.promise;
    });
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
      afterTargetCreated,
    });

    const creation = control.createPageTarget('about:blank#crash-sentinel');
    const hookRef = await hookEntered.promise;

    expect(Object.keys(hookRef)).toEqual([]);
    expect(
      fake.send.mock.calls.some(
        ([, method, params]) =>
          method === 'Target.getTargetInfo' &&
          (params as Record<string, unknown> | undefined)?.targetId === 'target-created-1',
      ),
    ).toBe(false);

    releaseHook.resolve();
    await expect(creation).resolves.toBe(hookRef);
    expect(afterTargetCreated).toHaveBeenCalledExactlyOnceWith(hookRef);
    await control.close();
  });

  it('rejects non-canonical target URLs before issuing a create command', async () => {
    const fake = fakeChromium();
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });
    const sendsBefore = fake.send.mock.calls.length;

    await expect(control.createPageTarget('not an absolute URL')).rejects.toThrow(
      /absolute and canonical/,
    );
    expect(fake.send).toHaveBeenCalledTimes(sendsBefore);
    await control.close();
  });

  it('fails closed on malformed protocol records and contains a known created target', async () => {
    const fake = fakeChromium({ browserContextId: 'context-a' });
    fake.setIntercept(({ method, params }) => {
      if (method !== 'Target.getTargetInfo' || params?.targetId !== 'target-created-1') {
        return undefined;
      }
      return Promise.resolve({
        targetInfo: {
          targetId: 'target-created-1',
          type: 'page',
          title: '',
          url: 'about:blank',
          // Required `attached` field deliberately absent.
          browserContextId: 'context-a',
        },
      });
    });
    const control = await createChromiumTargetControl({
      context: fake.context,
      anchorPage: fake.anchorPage,
    });

    await expect(control.createPageTarget('about:blank')).rejects.toThrow(/invalid target record/);
    await vi.waitFor(() => {
      expect(fake.targets.has('target-created-1')).toBe(false);
    });
    await control.close();
  });

  it('does not retain provider connection URLs in setup errors', async () => {
    const fake = fakeChromium();
    const privateUrl = 'wss://connect.browserbase.com/session?apiKey=secret';
    fake.newCDPSession.mockRejectedValueOnce(new Error(`transport failed at ${privateUrl}`));

    let thrown: unknown;
    try {
      await createChromiumTargetControl({
        context: fake.context,
        anchorPage: fake.anchorPage,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ChromiumTargetControlError);
    expect(String(thrown)).not.toContain(privateUrl);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('does not attach when setup is already cancelled', async () => {
    const fake = fakeChromium();
    const abort = new AbortController();
    const reason = new Error('cancel before setup');
    abort.abort(reason);

    await expect(
      createChromiumTargetControl({
        context: fake.context,
        anchorPage: fake.anchorPage,
        signal: abort.signal,
      }),
    ).rejects.toBe(reason);
    expect(fake.newCDPSession).not.toHaveBeenCalled();
  });
});
