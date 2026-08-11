import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import {
  BrowserRefNotFoundError,
  type BrowserAdapter,
} from './adapter.js';
import { launchPersistentChrome } from './playwrightAdapter.js';

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

describe('Playwright browser adapter', () => {
  let adapter: BrowserAdapter;
  let fixtureServer: FixtureServer;
  let profileDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), 'evidence-agent-chrome-'));
    adapter = await launchPersistentChrome({ profileDir, headless: true });
  }, 30_000);

  afterEach(async () => {
    await adapter.closeTab();
  });

  afterAll(async () => {
    await adapter?.close();
    await fixtureServer?.close();
    if (profileDir !== undefined) {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it(
    'round-trips an outline ref to the intended interactive element',
    async () => {
      await adapter.newTab();
      await adapter.goto(fixtureServer.url('/'));

      const firstOutline = await adapter.outline();
      const buttonRef = refFor(firstOutline, 'button "Announce ready"');
      const secondOutline = await adapter.outline();

      expect(refFor(secondOutline, 'button "Announce ready"')).toBe(buttonRef);
      await adapter.click(buttonRef);
      expect(await adapter.outline()).toContain('Ready');

      await adapter.goto(fixtureServer.url('/second.html'));
      await expect(adapter.click(buttonRef)).rejects.toBeInstanceOf(
        BrowserRefNotFoundError,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'launches, navigates, reports page metadata, and closes cleanly',
    async () => {
      await adapter.newTab();
      await adapter.goto(fixtureServer.url('/'));

      expect(adapter.currentUrl()).toBe(fixtureServer.url('/'));
      expect(await adapter.title()).toBe('Browser Adapter Fixture');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'opens a fresh blank tab for each sequential run',
    async () => {
      await adapter.newTab();
      await adapter.goto(fixtureServer.url('/second.html'));
      expect(await adapter.title()).toBe('Second Fixture Page');
      await adapter.closeTab();

      await adapter.newTab();
      expect(adapter.currentUrl()).toBe('about:blank');
      expect(await adapter.title()).toBe('');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'allows only one active tab when two opens race',
    async () => {
      const results = await Promise.allSettled([
        adapter.newTab(),
        adapter.newTab(),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(adapter.currentUrl()).toBe('about:blank');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'supports ref-based typing, href resolution, and PNG capture',
    async () => {
      await adapter.newTab();
      await adapter.goto(fixtureServer.url('/'));
      const outline = await adapter.outline();
      const inputRef = refFor(outline, 'textbox "Evidence query"');
      const linkRef = refFor(outline, 'link "Visit second page"');

      await adapter.type(inputRef, 'quarterly controls');
      expect(await adapter.outline()).toContain('quarterly controls');
      expect(await adapter.resolveHref(linkRef)).toBe(
        fixtureServer.url('/second.html'),
      );

      const png = await adapter.screenshot();
      expect(Array.from(png.subarray(0, PNG_MAGIC.length))).toEqual(PNG_MAGIC);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'fetches with cookies from the persistent browser context',
    async () => {
      await adapter.newTab();
      await adapter.goto(fixtureServer.url('/'));

      const response = await adapter.fetch(
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
});
