import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Disposable, Frame, Page } from 'playwright';

import {
  createBusyResourceRegistry,
  EXCLUSIVE_ACCESS,
} from '../tools/registry.js';
import type {
  ChromiumPageTargetRef,
  ChromiumTargetControl,
} from './chromiumTargetControl.js';
import { PlaywrightBrowserController } from './playwrightBrowserController.js';

interface FakePageOptions {
  matches?: boolean;
  inspectError?: string;
  closeError?: string;
  markError?: string;
  markGate?: Promise<void>;
  gotoNeverSettles?: boolean;
  opener?: () => Page | null;
  beforeClose?: () => void | Promise<void>;
}

function fakePage(options: FakePageOptions = {}): {
  page: Page;
  close: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
} {
  let closed = false;
  let matches = options.matches ?? false;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const frame = {
    url: () => 'about:blank',
    isDetached: () => false,
  } as unknown as Frame;
  const close = vi.fn(async () => {
    if (options.closeError !== undefined) throw new Error(options.closeError);
    if (closed) return;
    await options.beforeClose?.();
    closed = true;
    for (const listener of listeners.get('close') ?? []) listener();
  });
  const evaluate = vi.fn(async (script: unknown) => {
    if (options.inspectError !== undefined) throw new Error(options.inspectError);
    const source = String(script);
    if (source.includes('Object.defineProperty(window, property')) {
      matches = true;
      return true;
    }
    return matches;
  });
  const goto = vi.fn(async () => {
    if (options.gotoNeverSettles === true) {
      await new Promise<never>(() => undefined);
    }
  });
  const page = {
    isClosed: () => closed,
    close,
    evaluate,
    goto,
    addInitScript: vi.fn(async () => {
      await options.markGate;
      if (options.markError !== undefined) throw new Error(options.markError);
    }),
    opener: vi.fn(async () => options.opener?.() ?? null),
    frames: () => [frame],
    mainFrame: () => frame,
    url: () => 'about:blank',
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
    }),
  } as unknown as Page;
  return { page, close, evaluate, goto };
}

function fakeContext(
  initialPages: Page[],
  nextPage?: Page | readonly Page[],
  options: {
    newPageNeverSettles?: boolean;
    newPageGate?: Promise<void>;
    addInitScriptGate?: Promise<void>;
    disposeInitScriptError?: string;
  } = {},
): {
  context: BrowserContext;
  addInitScript: ReturnType<typeof vi.fn>;
  initScriptDisposals: Array<ReturnType<typeof vi.fn>>;
  addPage(page: Page): void;
} {
  const pageListeners: Array<(page: Page) => void> = [];
  const pages = [...initialPages];
  const initScriptDisposals: Array<ReturnType<typeof vi.fn>> = [];
  const nextPages =
    nextPage === undefined
      ? []
      : Array.isArray(nextPage)
        ? [...nextPage]
        : [nextPage];
  const addInitScript = vi.fn(async () => {
    await options.addInitScriptGate;
    const dispose = vi.fn(async () => {
      if (options.disposeInitScriptError !== undefined) {
        throw new Error(options.disposeInitScriptError);
      }
    });
    initScriptDisposals.push(dispose);
    return { dispose } as unknown as Disposable;
  });
  const addPage = (page: Page): void => {
    pages.push(page);
    for (const listener of pageListeners) listener(page);
  };
  const context = {
    pages: vi.fn(() => [...pages]),
    addInitScript,
    on: vi.fn((event: string, listener: (page: Page) => void) => {
      if (event === 'page') pageListeners.push(listener);
    }),
    newPage: vi.fn(async () => {
      if (options.newPageNeverSettles === true) {
        await new Promise<never>(() => undefined);
      }
      await options.newPageGate;
      const createdPage = nextPages.shift();
      if (createdPage === undefined) throw new Error('No fake new page configured');
      addPage(createdPage);
      return createdPage;
    }),
    isClosed: () => false,
    browser: () => ({ isConnected: () => true }),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  return { context, addInitScript, initScriptDisposals, addPage };
}

function fakeTargetControl(context: BrowserContext): ChromiumTargetControl {
  const ref = Object.freeze({}) as ChromiumPageTargetRef;
  let pagePromise: Promise<Page> | undefined;
  return {
    listPageTargets: vi.fn(async () => []),
    createPageTarget: vi.fn(async () => {
      pagePromise = context.newPage();
      await pagePromise;
      return ref;
    }),
    awaitPage: vi.fn(async () => {
      if (pagePromise === undefined) throw new Error('No fake target was created');
      return pagePromise;
    }),
    closeTarget: vi.fn(async () => {
      const page = await pagePromise;
      if (page !== undefined && !page.isClosed()) {
        await page.close({ runBeforeUnload: false });
      }
    }),
    drainContainment: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('PlaywrightBrowserController durable run page ownership', () => {
  it('inspects the complete snapshot before closing and fails closed on uncertainty', async () => {
    const matching = fakePage({ matches: true });
    const unreadable = fakePage({ inspectError: 'secret driver detail' });
    const unrelated = fakePage();
    const { context, addInitScript } = fakeContext([
      matching.page,
      unreadable.page,
      unrelated.page,
    ]);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });

    let error: unknown;
    try {
      await controller.initializeRunPageOwnership('private-run-id');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not inspect every browser page/i);
    expect((error as Error).message).not.toContain('private-run-id');
    expect((error as Error).message).not.toContain('secret driver detail');
    expect(matching.close).not.toHaveBeenCalled();
    expect(unreadable.close).not.toHaveBeenCalled();
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(addInitScript).not.toHaveBeenCalled();
  });

  it('closes every exact match, preserves unrelated pages, and binds idempotently', async () => {
    const main = fakePage({ matches: true });
    const popup = fakePage({ matches: true });
    const unrelated = fakePage();
    const { context, addInitScript } = fakeContext([
      unrelated.page,
      main.page,
      popup.page,
    ]);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });

    await controller.initializeRunPageOwnership('stable-run-id');
    await controller.initializeRunPageOwnership('stable-run-id');

    expect(main.close).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(addInitScript).toHaveBeenCalledOnce();
    await expect(
      controller.initializeRunPageOwnership('different-run-id'),
    ).rejects.toThrow(/different durable run/i);
  });

  it('rebinds a reused controller only after the prior run closes every owned page', async () => {
    const user = fakePage();
    const firstTask = fakePage();
    const secondTask = fakePage();
    const { context, addInitScript, initScriptDisposals } = fakeContext(
      [user.page],
      [firstTask.page, secondTask.page],
    );
    const controller = new PlaywrightBrowserController({
      context,
      preexistingSessionPages: [user.page],
    });

    await controller.initializeRunPageOwnership('first-run');
    await controller.newTab();
    await expect(
      controller.initializeRunPageOwnership('second-run'),
    ).rejects.toThrow(/different durable run/i);

    await controller.closeTaskPages();
    await controller.initializeRunPageOwnership('second-run');
    await controller.newTab();
    await controller.closeTaskPages();

    expect(firstTask.close).toHaveBeenCalledOnce();
    expect(secondTask.close).toHaveBeenCalledOnce();
    expect(user.close).not.toHaveBeenCalled();
    expect(addInitScript).toHaveBeenCalledTimes(2);
    expect(initScriptDisposals).toHaveLength(2);
    for (const dispose of initScriptDisposals) {
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it('does not rebind after prior-run page cleanup fails', async () => {
    const task = fakePage({ closeError: 'driver detail' });
    const { context, initScriptDisposals } = fakeContext([], task.page);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });

    await controller.initializeRunPageOwnership('first-run');
    await controller.newTab();
    await expect(controller.closeTaskPages()).rejects.toThrow(
      /could not close every task page/i,
    );
    await expect(
      controller.initializeRunPageOwnership('second-run'),
    ).rejects.toThrow(/different durable run/i);
    await expect(
      controller.initializeRunPageOwnership('first-run'),
    ).rejects.toThrow(/cleanup|replace the controller/i);
    expect(initScriptDisposals).toHaveLength(1);
    expect(initScriptDisposals[0]).not.toHaveBeenCalled();
  });

  it('closes a popup event delivered during cleanup before binding the next run', async () => {
    const user = fakePage();
    let firstPage!: Page;
    const latePopup = fakePage({ opener: () => firstPage });
    let addLatePopup!: (page: Page) => void;
    const firstTask = fakePage({
      beforeClose: async () => {
        addLatePopup(latePopup.page);
        await Promise.resolve();
      },
    });
    firstPage = firstTask.page;
    const secondTask = fakePage();
    const { context, addPage } = fakeContext(
      [user.page],
      [firstTask.page, secondTask.page],
    );
    addLatePopup = addPage;
    const controller = new PlaywrightBrowserController({
      context,
      preexistingSessionPages: [user.page],
    });

    await controller.initializeRunPageOwnership('first-run');
    await controller.newTab();
    await controller.closeTaskPages();
    await controller.initializeRunPageOwnership('second-run');
    await controller.newTab();
    await controller.closeTaskPages();

    expect(firstTask.close).toHaveBeenCalledOnce();
    expect(latePopup.close).toHaveBeenCalledOnce();
    expect(secondTask.close).toHaveBeenCalledOnce();
    expect(user.close).not.toHaveBeenCalled();
  });

  it('rescans for a marked popup that appears behind the first recovery snapshot', async () => {
    const main = fakePage({ matches: true });
    const latePopup = fakePage({ matches: true });
    const unrelated = fakePage();
    const { context } = fakeContext([]);
    vi.mocked(context.pages)
      .mockImplementationOnce(() => [unrelated.page, main.page])
      .mockImplementationOnce(() => [unrelated.page, latePopup.page])
      .mockImplementation(() => [unrelated.page]);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });

    await controller.initializeRunPageOwnership('stable-run-id');

    expect(main.close).toHaveBeenCalledOnce();
    expect(latePopup.close).toHaveBeenCalledOnce();
    expect(unrelated.close).not.toHaveBeenCalled();
  });

  it('attempts every matching close and does not arm ownership after cleanup fails', async () => {
    const wedged = fakePage({ matches: true, closeError: 'provider capability URL' });
    const closable = fakePage({ matches: true });
    const { context, addInitScript } = fakeContext([wedged.page, closable.page]);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });

    let error: unknown;
    try {
      await controller.initializeRunPageOwnership('stable-run-id');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not close 1 stale task page/i);
    expect((error as Error).message).not.toContain('provider capability URL');
    expect(wedged.close).toHaveBeenCalledOnce();
    expect(closable.close).toHaveBeenCalledOnce();
    expect(addInitScript).not.toHaveBeenCalled();
  });

  it('closes a newly claimed task page when its durable mark cannot be installed', async () => {
    const task = fakePage({ markError: 'raw marker installation detail' });
    const { context } = fakeContext([], task.page);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });
    await controller.initializeRunPageOwnership('stable-run-id');

    let error: unknown;
    try {
      await controller.newTab();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not durably mark/i);
    expect((error as Error).message).not.toContain('raw marker installation detail');
    expect(task.close).toHaveBeenCalledOnce();
  });

  it('settles cancellation even when page creation never settles', async () => {
    const { context } = fakeContext([], undefined, {
      newPageNeverSettles: true,
    });
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });
    const busyRegistry = createBusyResourceRegistry();
    controller.setBusyRegistry(busyRegistry);
    const abort = new AbortController();
    const reason = new Error('whole-run deadline');
    const preparation = controller.prepareTaskPage({
      ownershipId: 'stable-run-id',
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(context.newPage).toHaveBeenCalledOnce());

    abort.abort(reason);

    await expect(preparation).rejects.toBe(reason);
    await expect(
      busyRegistry.waitUntilFree(EXCLUSIVE_ACCESS, 10),
    ).resolves.toBe(false);
    let cleanupSettled = false;
    void controller.closeTaskPages().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
  });

  it('fences late ownership initialization until its provider effect settles', async () => {
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    const { context, addInitScript } = fakeContext([], undefined, {
      addInitScriptGate: initializationGate,
    });
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });
    const busyRegistry = createBusyResourceRegistry();
    controller.setBusyRegistry(busyRegistry);
    const abort = new AbortController();
    const reason = new Error('whole-run deadline');
    const preparation = controller.prepareTaskPage({
      ownershipId: 'stable-run-id',
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(addInitScript).toHaveBeenCalledOnce());

    abort.abort(reason);

    await expect(preparation).rejects.toBe(reason);
    expect(context.newPage).not.toHaveBeenCalled();
    let cleanupSettled = false;
    const cleanup = controller.closeTaskPages().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    const ownershipSettled = busyRegistry.waitUntilFree(
      EXCLUSIVE_ACCESS,
      1_000,
    );
    releaseInitialization();
    await expect(ownershipSettled).resolves.toBe(true);
    await expect(cleanup).resolves.toBeUndefined();
  });

  it('holds cleanup until a page created after cancellation is contained', async () => {
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const task = fakePage();
    const { context } = fakeContext([], task.page, {
      newPageGate: creationGate,
    });
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });
    const busyRegistry = createBusyResourceRegistry();
    controller.setBusyRegistry(busyRegistry);
    const abort = new AbortController();
    const reason = new Error('whole-run deadline');
    const preparation = controller.prepareTaskPage({
      ownershipId: 'stable-run-id',
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(context.newPage).toHaveBeenCalledOnce());

    abort.abort(reason);
    await expect(preparation).rejects.toBe(reason);
    let cleanupSettled = false;
    const cleanup = controller.closeTaskPages().then(() => {
      cleanupSettled = true;
    });
    let containmentSettled = false;
    const containment = busyRegistry
      .waitUntilFree(EXCLUSIVE_ACCESS, 1_000)
      .then((free) => {
        containmentSettled = free;
      });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(containmentSettled).toBe(false);

    releaseCreation();
    await vi.waitFor(() => expect(task.close).toHaveBeenCalled());
    await expect(containment).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it('holds cleanup until an interrupted durable page claim settles', async () => {
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const task = fakePage({ markGate: claimGate });
    const { context } = fakeContext([], task.page);
    const controller = new PlaywrightBrowserController({
      context,
      targetControl: fakeTargetControl(context),
    });
    const busyRegistry = createBusyResourceRegistry();
    controller.setBusyRegistry(busyRegistry);
    const abort = new AbortController();
    const reason = new Error('whole-run deadline');
    const preparation = controller.prepareTaskPage({
      ownershipId: 'stable-run-id',
      signal: abort.signal,
    });
    await vi.waitFor(() =>
      expect(task.page.addInitScript).toHaveBeenCalledOnce(),
    );

    abort.abort(reason);

    await expect(preparation).rejects.toBe(reason);
    let cleanupSettled = false;
    const cleanup = controller.closeTaskPages().then(() => {
      cleanupSettled = true;
    });
    let containmentSettled = false;
    const containment = busyRegistry
      .waitUntilFree(EXCLUSIVE_ACCESS, 1_000)
      .then((free) => {
        containmentSettled = free;
      });
    await Promise.resolve();
    expect(task.close).toHaveBeenCalled();
    expect(cleanupSettled).toBe(false);
    expect(containmentSettled).toBe(false);

    releaseClaim();

    await expect(containment).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it('quarantines and closes the owned page before rejecting an interrupted navigation', async () => {
    const user = fakePage();
    const task = fakePage({ gotoNeverSettles: true });
    const { context } = fakeContext([user.page], task.page);
    const controller = new PlaywrightBrowserController({
      context,
      preexistingSessionPages: [user.page],
      targetControl: fakeTargetControl(context),
    });
    controller.setBusyRegistry(createBusyResourceRegistry());
    const abort = new AbortController();
    const reason = new Error('whole-run deadline');
    const preparation = controller.prepareTaskPage({
      ownershipId: 'stable-run-id',
      startUrl: 'https://example.test/slow',
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(task.goto).toHaveBeenCalledOnce());

    abort.abort(reason);

    await expect(preparation).rejects.toBe(reason);
    await expect(controller.closeTaskPages()).resolves.toBeUndefined();
    expect(task.close).toHaveBeenCalled();
    expect(user.close).not.toHaveBeenCalled();
  });
});
