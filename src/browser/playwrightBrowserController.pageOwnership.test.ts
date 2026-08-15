import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import type { BrowserController } from './controller.js';
import {
  launchPersistentChrome,
  PlaywrightBrowserController,
} from './playwrightBrowserController.js';

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
    controller = new PlaywrightBrowserController({
      context,
      preexistingSessionPages: preexistingPages,
    });
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

      await controller.newTab();
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
});
