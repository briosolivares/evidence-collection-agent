import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { createBusyResourceRegistry } from '../tools/registry.js';
import { runBrowserProgram } from '../v3/browser/runner.js';
import { AttachedChromeBrowserSessionProvider } from './attachedChromeBrowserSessionProvider.js';
import type { BrowserController } from './controller.js';
import { launchPersistentChrome } from './playwrightBrowserController.js';

const TEST_TIMEOUT_MS = 45_000;
const AMBIENT_URL = 'about:blank#ambient-authority-attached';
const AMBIENT_TITLE = 'Ambient authority secret attached';
const OWNED_URL = 'about:blank#owned-authority-attached';

async function targetIdForPage(
  context: BrowserContext,
  page: Page,
): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const response = await session.send('Target.getTargetInfo');
    return response.targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

describe('attached browser target authority', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps ambient targets invisible and immutable while owned helpers still work',
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'browser-target-authority-'));
      let ownerContext: BrowserContext | undefined;
      let controller: BrowserController | undefined;

      try {
        const profileDir = join(rootDir, 'profile');
        ownerContext = await launchPersistentChrome({ profileDir, headless: true });
        const ambientPage = await ownerContext.newPage();
        await ambientPage.goto(AMBIENT_URL);
        await ambientPage.evaluate((title) => {
          document.title = title;
        }, AMBIENT_TITLE);
        const ambientTargetId = await targetIdForPage(ownerContext, ambientPage);
        const port = Number(
          (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'))
            .split('\n')[0]
            ?.trim(),
        );
        expect(Number.isInteger(port) && port > 0).toBe(true);
        controller = await new AttachedChromeBrowserSessionProvider({
          cdpEndpoint: `http://127.0.0.1:${port}`,
        }).createSession();
        controller.setBusyRegistry?.(createBusyResourceRegistry());
        if (controller.prepareTaskPage === undefined) {
          throw new Error('Attached controller omitted v3 task-page preparation.');
        }
        await controller.prepareTaskPage({
          ownershipId: 'attached-ambient-target-authority',
        });

        const command = await controller.openCommandSession();
        const result = await runBrowserProgram({
          code: `
            const refused = {};
            const attempt = async (name, operation) => {
              try {
                await operation();
                refused[name] = 'UNEXPECTED_SUCCESS';
              } catch (error) {
                refused[name] = error instanceof Error ? error.message : String(error);
              }
            };
            const before = await browser.pages();
            const pinned = await browser.cdp('Target.getTargetInfo');
            const created = await browser.open(${JSON.stringify(OWNED_URL)});
            await browser.activate(created.targetId);
            const ownedInfo = await browser.cdp('Target.getTargetInfo', {
              targetId: created.targetId,
            });
            const afterOpen = await browser.pages();
            await attempt('activateAmbient', () => browser.activate(${JSON.stringify(ambientTargetId)}));
            await attempt('closeAmbient', () => browser.close(${JSON.stringify(ambientTargetId)}));
            await attempt('inspectAmbient', () => browser.cdp('Target.getTargetInfo', {
              targetId: ${JSON.stringify(ambientTargetId)},
            }));
            await attempt('attachAmbient', () => browser.cdp('Target.attachToTarget', {
              targetId: ${JSON.stringify(ambientTargetId)}, flatten: true,
            }));
            await attempt('discoverTargets', () => browser.cdp('Target.setDiscoverTargets', {
              discover: true,
            }));
            await attempt('closeBrowser', () => browser.cdp('Browser.close'));
            await attempt('inspectBrowser', () => browser.cdp('Browser.getVersion'));
            await browser.close(created.targetId);
            const afterClose = await browser.pages();
            return { before, pinned, created, ownedInfo, afterOpen, afterClose, refused };
          `,
          cwd: rootDir,
          env: { PATH: process.env.PATH },
          page: { pageId: command.pageId, targetId: command.targetId },
          timeoutMs: 20_000,
          maxOutputBytes: 100_000,
          sendCdp: (method, params) => command.send(method, params),
          navigate: (url, options) => command.navigate(url, options),
          upload: (backendDOMNodeId, workspacePath) =>
            command.upload(backendDOMNodeId, workspacePath),
        });
        await command.close();

        expect(result.status, result.error?.message).toBe('exited');
        const value = result.value as {
          before: Array<{ targetId: string }>;
          pinned: { targetInfo: { targetId: string } };
          created: { targetId: string; url: string };
          ownedInfo: { targetInfo: { targetId: string; url: string } };
          afterOpen: Array<{ targetId: string; url: string }>;
          afterClose: Array<{ targetId: string }>;
          refused: Record<string, string>;
        };
        expect(value.before).toEqual([
          expect.objectContaining({ targetId: command.targetId }),
        ]);
        expect(value.pinned.targetInfo.targetId).toBe(command.targetId);
        expect(value.created).toEqual(expect.objectContaining({ url: OWNED_URL }));
        expect(value.ownedInfo.targetInfo).toEqual(
          expect.objectContaining({
            targetId: value.created.targetId,
            url: OWNED_URL,
          }),
        );
        expect(value.afterOpen).toHaveLength(2);
        expect(value.afterOpen).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ targetId: command.targetId }),
            expect.objectContaining({ targetId: value.created.targetId, url: OWNED_URL }),
          ]),
        );
        expect(value.afterClose).toEqual([
          expect.objectContaining({ targetId: command.targetId }),
        ]);
        expect(Object.values(value.refused)).toHaveLength(7);
        for (const message of Object.values(value.refused)) {
          expect(message).not.toBe('UNEXPECTED_SUCCESS');
          expect(message).toMatch(/not allowed|outside this run/i);
        }

        const publicResult = JSON.stringify(result);
        expect(publicResult).not.toContain(AMBIENT_URL);
        expect(publicResult).not.toContain(AMBIENT_TITLE);
        expect(publicResult).not.toContain(ambientTargetId);
        expect(ambientPage.isClosed()).toBe(false);
        expect(ambientPage.url()).toBe(AMBIENT_URL);
        expect(await ambientPage.title()).toBe(AMBIENT_TITLE);

        await controller.closeTaskPages();
        expect(await controller.pages()).toEqual([]);
        expect(ambientPage.isClosed()).toBe(false);
        await controller.close();
        expect(ownerContext.isClosed()).toBe(false);
        expect(ambientPage.isClosed()).toBe(false);
      } finally {
        await controller?.close().catch(() => undefined);
        await ownerContext?.close().catch(() => undefined);
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
