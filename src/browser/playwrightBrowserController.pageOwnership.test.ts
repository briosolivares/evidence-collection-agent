import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import type {
  BrowserController,
  BrowserTaskPagePreparation,
} from './controller.js';
import { AttachedChromeBrowserSessionProvider } from './attachedChromeBrowserSessionProvider.js';
import { createChromiumTargetControl } from './chromiumTargetControl.js';
import {
  launchPersistentChrome,
  PlaywrightBrowserController,
} from './playwrightBrowserController.js';
import { createBusyResourceRegistry } from '../tools/registry.js';

async function waitForOwnedPages(
  controller: BrowserController,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    if ((await controller.pages()).length === count) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${count} owned pages; saw ${(await controller.pages()).length}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function prepareTaskPage(
  controller: BrowserController,
  request: BrowserTaskPagePreparation,
): Promise<void> {
  if (controller.prepareTaskPage === undefined) {
    throw new Error('Browser controller omitted v3 task-page preparation.');
  }
  await controller.prepareTaskPage(request);
}

describe('PlaywrightBrowserController task-page ownership', () => {
  let context: BrowserContext;
  let controller: BrowserController;
  let profileDir: string;
  let preexistingPages: Page[];

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'browser-page-ownership-'));
    context = await launchPersistentChrome({ profileDir, headless: true });
    const initial = context.pages()[0] ?? (await context.newPage());
    const second = await context.newPage();
    preexistingPages = [initial, second];
    const targetControl = await createChromiumTargetControl({
      context,
      anchorPage: initial,
    });
    controller = new PlaywrightBrowserController({
      context,
      preexistingSessionPages: preexistingPages,
      targetControl,
    });
    controller.setBusyRegistry?.(createBusyResourceRegistry());
  }, 30_000);

  afterAll(async () => {
    await controller?.close();
    if (profileDir !== undefined) {
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    'closes task, popup, and raw-created pages while preserving user pages',
    async () => {
      expect(await controller.pages()).toEqual([]);

      await prepareTaskPage(controller, {
        ownershipId: 'page-ownership-cleanup-test',
      });
      await waitForOwnedPages(controller, 1);
      const taskPage = context
        .pages()
        .find((page) => !preexistingPages.includes(page));
      expect(taskPage).toBeDefined();
      await taskPage!.evaluate(() => {
        location.hash = 'task';
      });

      const popupEvent = context.waitForEvent('page');
      await taskPage!.evaluate(() => {
        window.open('about:blank#popup', '_blank');
      });
      const popupPage = await popupEvent;
      await waitForOwnedPages(controller, 2);

      // This page has no owned opener and no Target.createTarget receipt. It
      // represents a user opening a tab concurrently in attached Chrome.
      const concurrentUserPage = await context.newPage();
      await concurrentUserPage.evaluate(() => {
        location.hash = 'user';
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await controller.pages()).toHaveLength(2);

      const rawPageEvent = context.waitForEvent('page');
      const commandSession = await controller.openCommandSession();
      const created = (await commandSession.send('Target.createTarget', {
        url: 'about:blank#raw',
      })) as { targetId: string };
      expect(created.targetId).toBeTruthy();
      await commandSession.close();
      const rawPage = await rawPageEvent;
      await waitForOwnedPages(controller, 3);
      await controller.refreshAfterExternalCommands();

      const owned = await controller.pages();
      expect(owned).toHaveLength(3);
      expect(owned.map((page) => page.url).sort()).toEqual(
        ['about:blank#popup', 'about:blank#raw', 'about:blank#task'].sort(),
      );

      const closeOrder: string[] = [];
      taskPage!.on('close', () => closeOrder.push('task'));
      popupPage.on('close', () => closeOrder.push('popup'));
      rawPage.on('close', () => closeOrder.push('raw'));

      await controller.closeTaskPages();
      await controller.closeTaskPages();

      expect(closeOrder).toEqual(['raw', 'popup', 'task']);
      expect(await controller.pages()).toEqual([]);
      for (const page of [...preexistingPages, concurrentUserPage]) {
        expect(page.isClosed()).toBe(false);
      }
      expect(context.pages()).toEqual([
        ...preexistingPages,
        concurrentUserPage,
      ]);
    },
    15_000,
  );

  it(
    'reclaims only same-run pages after an attached-client reconnect',
    async () => {
      const durableRunId = 'v3-run-2026-08-15-reconnect-test';
      const userPages = [...context.pages()];
      await prepareTaskPage(controller, { ownershipId: durableRunId });
      const taskPage = context
        .pages()
        .find((page) => !userPages.includes(page));
      expect(taskPage).toBeDefined();

      await taskPage!.setContent(
        '<a id="popup" href="about:blank#durable-popup" target="_blank" ' +
          'rel="noopener">open popup</a>',
      );
      const [popupPage] = await Promise.all([
        context.waitForEvent('page'),
        taskPage!.click('#popup'),
      ]);
      await waitForOwnedPages(controller, 2);
      const mutationResistance = await taskPage!.evaluate(() => {
        const property = '__sherlock_run_page_owner_v1__';
        const before = Object.getOwnPropertyDescriptor(window, property);
        try {
          Object.defineProperty(window, property, { value: 'site-overwrite' });
        } catch {
          // Expected for the controller's non-configurable marker.
        }
        const after = Object.getOwnPropertyDescriptor(window, property);
        return {
          sameValue: before?.value === after?.value,
          enumerable: after?.enumerable,
          configurable: after?.configurable,
          writable: after?.writable,
        };
      });
      expect(mutationResistance).toEqual({
        sameValue: true,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      await Promise.all([
        taskPage!.goto(
          'data:text/html,<title>cross-origin-main</title><h1>main</h1>',
        ),
        popupPage.goto(
          'data:text/html,<title>cross-origin-popup</title><h1>popup</h1>',
        ),
      ]);

      // A new user tab has neither an owned opener nor the exact marker. It
      // must survive both a wrong-run scan and the real same-run recovery.
      const concurrentUserPage = await context.newPage();
      await concurrentUserPage.goto(
        'data:text/html,<title>concurrent-user</title><h1>user</h1>',
      );

      const port = Number(
        (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'))
          .split('\n')[0]
          ?.trim(),
      );
      expect(Number.isInteger(port) && port > 0).toBe(true);
      const attachedEndpoint = `http://127.0.0.1:${port}`;
      const wrongRunController = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: attachedEndpoint,
      }).createSession();
      await wrongRunController.initializeRunPageOwnership?.('another-durable-run');
      expect(taskPage!.isClosed()).toBe(false);
      expect(popupPage.isClosed()).toBe(false);
      await wrongRunController.close();

      // A second provider call establishes a genuinely new Playwright CDP
      // client. Every live tab is pre-existing to it, including the two stale
      // task pages, just as after a harness process reconnects.
      const reconnected = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: attachedEndpoint,
      }).createSession();
      reconnected.setBusyRegistry?.(createBusyResourceRegistry());
      await reconnected.initializeRunPageOwnership?.(durableRunId);
      await reconnected.initializeRunPageOwnership?.(durableRunId);

      expect(taskPage!.isClosed()).toBe(true);
      expect(popupPage.isClosed()).toBe(true);
      for (const page of [...userPages, concurrentUserPage]) {
        expect(page.isClosed()).toBe(false);
      }

      await prepareTaskPage(reconnected, { ownershipId: durableRunId });
      const listed = await reconnected.pages();
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(durableRunId);
      expect(JSON.stringify(listed)).not.toContain('__sherlock_run_page_owner');
      await reconnected.closeTaskPages();
      await reconnected.closeTaskPages();
      expect(await reconnected.pages()).toEqual([]);
      for (const page of [...userPages, concurrentUserPage]) {
        expect(page.isClosed()).toBe(false);
      }
      await reconnected.close();
    },
    45_000,
  );

  it(
    'closes a real navigating task page on preparation cancellation while preserving user tabs',
    async () => {
      const durableRunId = 'v3-run-2026-08-15-reconnect-test';
      const userPages = [...context.pages()];
      let releaseRoute!: () => void;
      let routeStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        routeStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRoute = resolve;
      });
      const pattern = 'https://deadline-preparation.test/**';
      await context.route(pattern, async (route) => {
        routeStarted();
        await gate;
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<title>too late</title>',
        }).catch(() => undefined);
      });
      const abort = new AbortController();
      const reason = new Error('whole-run deadline');
      controller.setBusyRegistry?.(createBusyResourceRegistry());

      try {
        const preparation = prepareTaskPage(controller, {
          ownershipId: durableRunId,
          startUrl: 'https://deadline-preparation.test/slow',
          signal: abort.signal,
        });
        await started;

        abort.abort(reason);

        await expect(preparation).rejects.toBe(reason);
        releaseRoute();
        await controller.closeTaskPages();
        for (const page of userPages) expect(page.isClosed()).toBe(false);
        expect(await controller.pages()).toEqual([]);
      } finally {
        releaseRoute();
        await context.unroute(pattern);
        await controller.closeTaskPages().catch(() => undefined);
      }
    },
    15_000,
  );

  it(
    'rebinds one real controller from run A to run B only after quiescent cleanup',
    async () => {
      const originalUserPages = [...context.pages()];
      await prepareTaskPage(controller, {
        ownershipId: 'sequential-real-run-a',
      });
      const runAMain = context
        .pages()
        .find((page) => !originalUserPages.includes(page));
      expect(runAMain).toBeDefined();
      await runAMain!.setContent(
        '<a id="popup" href="about:blank#a-popup" target="_blank">open</a>',
      );
      const [runAPopup] = await Promise.all([
        context.waitForEvent('page'),
        runAMain!.click('#popup'),
      ]);
      await waitForOwnedPages(controller, 2);

      await controller.closeTaskPages();

      expect(runAMain!.isClosed()).toBe(true);
      expect(runAPopup.isClosed()).toBe(true);
      const betweenRunsUserPage = await context.newPage();
      await betweenRunsUserPage.goto(
        'data:text/html,<title>between-runs-user</title><h1>user</h1>',
      );

      await prepareTaskPage(controller, {
        ownershipId: 'sequential-real-run-b',
      });
      expect(await controller.pages()).toHaveLength(1);
      await controller.closeTaskPages();

      for (const page of [...originalUserPages, betweenRunsUserPage]) {
        expect(page.isClosed()).toBe(false);
      }
      expect(await controller.pages()).toEqual([]);
    },
    40_000,
  );
});
