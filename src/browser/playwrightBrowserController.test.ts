import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import {
  BrowserRefNotFoundError,
  type BrowserController,
} from './controller.js';
import {
  LocalChromeBrowserSessionProvider,
  PlaywrightBrowserController,
} from './playwrightBrowserController.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BROWSER_TEST_TIMEOUT_MS = 15_000;

function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(
    new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`),
  );

  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName} in:\n${outline}`);
  }

  return match[1];
}

describe('Playwright browser controller', () => {
  let controller: BrowserController;
  let fixtureServer: FixtureServer;
  let profileDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), 'evidence-agent-chrome-'));
    const provider = new LocalChromeBrowserSessionProvider({
      profileDir,
      headless: true,
    });
    controller = await provider.createSession();
    expect(controller).toBeInstanceOf(PlaywrightBrowserController);
  }, 30_000);

  afterEach(async () => {
    await controller.closeTab();
  });

  afterAll(async () => {
    await controller?.close();
    await fixtureServer?.close();
    if (profileDir !== undefined) {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it(
    'round-trips an outline ref to the intended interactive element',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      const firstOutline = await controller.outline();
      const buttonRef = refFor(firstOutline, 'button "Announce ready"');
      const secondOutline = await controller.outline();

      expect(refFor(secondOutline, 'button "Announce ready"')).toBe(buttonRef);
      await controller.click(buttonRef);
      expect(await controller.outline()).toContain('Ready');

      await controller.goto(fixtureServer.url('/second.html'));
      await expect(controller.click(buttonRef)).rejects.toBeInstanceOf(
        BrowserRefNotFoundError,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'launches, navigates, reports page metadata, and closes cleanly',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      expect(controller.currentUrl()).toBe(fixtureServer.url('/'));
      expect(await controller.title()).toBe('Browser Controller Fixture');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'opens a fresh blank tab for each sequential run',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/second.html'));
      expect(await controller.title()).toBe('Second Fixture Page');
      await controller.closeTab();

      await controller.newTab();
      expect(controller.currentUrl()).toBe('about:blank');
      expect(await controller.title()).toBe('');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'allows only one active tab when two opens race',
    async () => {
      const results = await Promise.allSettled([
        controller.newTab(),
        controller.newTab(),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(controller.currentUrl()).toBe('about:blank');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'supports ref-based typing, href resolution, and PNG capture',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));
      const outline = await controller.outline();
      const inputRef = refFor(outline, 'textbox "Evidence query"');
      const linkRef = refFor(outline, 'link "Visit second page"');

      await controller.type(inputRef, 'quarterly controls');
      expect(await controller.outline()).toContain('quarterly controls');
      expect(await controller.resolveHref(linkRef)).toBe(
        fixtureServer.url('/second.html'),
      );

      const png = await controller.screenshot();
      expect(Array.from(png.subarray(0, PNG_MAGIC.length))).toEqual(PNG_MAGIC);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'fetches with cookies from the persistent browser context',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      const response = await controller.fetch(
        fixtureServer.url('/authenticated.bin'),
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(new TextDecoder().decode(response.bytes)).toBe(
        'browser-session-authenticated\n',
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'captures exact bytes through Chrome when the lightweight request client is blocked',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      const url = fixtureServer.url('/browser-only-document.htm');
      await expect(controller.fetch(url)).resolves.toMatchObject({ status: 403 });

      const result = await controller.download({ url });

      expect(result).toMatchObject({
        finalUrl: url,
        status: 200,
        headers: expect.objectContaining({
          'content-type': 'text/html; charset=utf-8',
        }),
      });
      expect(new TextDecoder().decode(result.bytes)).toBe(
        '<!doctype html><title>Browser-only filing</title><p>Exact filing bytes</p>\n',
      );
      expect(controller.currentUrl()).toBe(fixtureServer.url('/'));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
