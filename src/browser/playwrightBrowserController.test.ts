import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import {
  DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE,
  type BrowserObservation,
  type ElementRef,
} from './browserState.js';
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

/** Find one observed element by role and accessible name, or fail loudly. */
function elementRef(
  observation: BrowserObservation,
  role: string,
  name: string,
): ElementRef {
  const match = observation.elements.find(
    (element) => element.role === role && element.name === name,
  );
  if (match === undefined) {
    throw new Error(
      `No observed ${role} "${name}" in: ${JSON.stringify(observation.elements)}`,
    );
  }
  return match;
}

describe('Playwright browser controller', () => {
  let controller: BrowserController;
  // The same instance, typed for T9 surface not yet on the neutral
  // interface (resolveElementRef).
  let playwright: PlaywrightBrowserController;
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
    playwright = controller as PlaywrightBrowserController;
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

  it(
    'keeps pageId stable while navigation rotates the documentId',
    async () => {
      await controller.newTab();
      const listed = await controller.pages();
      // Exactly the task tab: the pre-existing session page and any earlier
      // download capture pages never entered the registry.
      expect(listed).toHaveLength(1);
      const before = listed[0];
      expect(before.active).toBe(true);
      expect(before.observationId).toBe(0);

      await controller.goto(fixtureServer.url('/'));
      const after = (await controller.pages())[0];
      expect(after.pageId).toBe(before.pageId);
      expect(after.documentId).not.toBe(before.documentId);
      expect(after.url).toBe(fixtureServer.url('/'));
      // pages() alone never advances observation identity.
      expect(after.observationId).toBe(0);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'observes elements bound to page, frame, and document, advancing ids per snapshot',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      const first = await controller.observe();
      expect(first.page.observationId).toBe(1);
      expect(first.changes.basis).toBe('full_snapshot');
      expect(first.views[0]?.need).toBe('interactive');
      expect(first.views[0]?.content).toContain('button "Announce ready"');

      const announce = elementRef(first, 'button', 'Announce ready');
      expect(announce.pageId).toBe(first.page.pageId);
      expect(announce.documentId).toBe(first.page.documentId);
      expect(
        first.page.frames.some(
          (frame) =>
            frame.frameId === announce.frameId &&
            frame.documentId === announce.documentId,
        ),
      ).toBe(true);

      const second = await controller.observe({ need: ['text'] });
      expect(second.page.observationId).toBe(2);
      expect(second.views[0]?.content).toContain(
        'This deterministic page exercises semantic browser observations.',
      );
      expect((await controller.pages())[0]?.observationId).toBe(2);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'invalidates prior-document element refs on navigation',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/rows.html'));
      const observation = await controller.observe();
      const target = elementRef(observation, 'button', 'Reverse rows');

      await controller.goto(fixtureServer.url('/second.html'));

      await expect(playwright.resolveElementRef(target)).rejects.toBeInstanceOf(
        BrowserRefNotFoundError,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'keeps a still-unique target actionable through unrelated DOM mutation',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/rows.html'));
      const observation = await controller.observe();
      const reverse = elementRef(observation, 'button', 'Reverse rows');
      const mutate = elementRef(observation, 'button', 'Add unrelated note');
      const strip = elementRef(observation, 'button', 'Strip observation markers');

      // Mutate the DOM in a way unrelated to the reverse button…
      await (await playwright.resolveElementRef(mutate)).click();
      // …and its ref still resolves and acts.
      await (await playwright.resolveElementRef(reverse)).click();

      // Even with the exact-node markers destroyed, a unique role/name
      // target still resolves through the fallback ladder.
      await (await playwright.resolveElementRef(strip)).click();
      await (await playwright.resolveElementRef(mutate)).click();

      const after = await controller.observe({ need: ['text'] });
      expect(after.views[0]?.content).toContain('Added later');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'never lets reordered duplicate rows retarget a mutating action by ordinal',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/rows.html'));
      const observation = await controller.observe();
      const deletes = observation.elements.filter(
        (element) => element.role === 'button' && element.name === 'Delete row',
      );
      expect(deletes.map((element) => element.ordinal)).toEqual([0, 1]);
      const alphaDelete = deletes[0];
      const reverse = elementRef(observation, 'button', 'Reverse rows');
      const strip = elementRef(observation, 'button', 'Strip observation markers');

      // Reorder the duplicate rows, then act on the ref observed for the
      // FIRST row: it must still hit row alpha (now last in the DOM).
      await (await playwright.resolveElementRef(reverse)).click();
      await (await playwright.resolveElementRef(alphaDelete)).click();
      const status = await controller.observe({ need: ['text'] });
      expect(status.views[0]?.content).toContain('Deleted alpha');

      // Without the exact-node markers, a duplicate-name ref must go stale
      // instead of falling back to an ordinal guess.
      await (await playwright.resolveElementRef(strip)).click();
      await expect(playwright.resolveElementRef(deletes[1])).rejects.toBeInstanceOf(
        BrowserRefNotFoundError,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'tracks popup identity across observations and switches selection to it',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/popup.html'));
      const main = (await controller.pages()).find((page) => page.active);
      expect(main).toBeDefined();

      const observation = await controller.observe();
      const opener = elementRef(observation, 'link', 'Open popup fixture');
      await (await playwright.resolveElementRef(opener)).click();

      await expect
        .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
        .toBe(2);
      const popup = (await controller.pages()).find(
        (page) => page.pageId !== main?.pageId,
      );
      expect(popup).toBeDefined();
      await expect
        .poll(
          async () =>
            (await controller.pages()).find((page) => page.pageId === popup?.pageId)
              ?.url ?? '',
          { timeout: 10_000 },
        )
        .toContain('/second.html');

      // Identity survives more than one observation of the popup.
      const first = await controller.observe({ pageId: popup?.pageId ?? '' });
      const second = await controller.observe({
        pageId: popup?.pageId ?? '',
        basedOnObservationId: first.page.observationId,
      });
      expect(first.page.pageId).toBe(popup?.pageId);
      expect(second.page.pageId).toBe(popup?.pageId);
      expect(second.page.observationId).toBe(first.page.observationId + 1);
      expect(second.page.documentId).toBe(first.page.documentId);
      expect(second.changes.basis).toBe('requested_observation');
      expect(second.changes.navigated).toBe(false);

      await expect(controller.switchPage('page-nope')).rejects.toThrow(
        'Unknown or closed browser pageId',
      );
      const selected = await controller.switchPage(popup?.pageId ?? '');
      expect(selected.active).toBe(true);
      expect(await controller.title()).toBe('Second Fixture Page');

      // Close the popup and reselect the original tab for suite cleanup.
      await controller.closeTab();
      await controller.switchPage(main?.pageId ?? '');
      expect(controller.currentUrl()).toBe(fixtureServer.url('/popup.html'));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'keeps frame identity across observations while frame navigation rotates its document',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/frames.html'));
      const before = (await controller.pages())[0];
      expect(before.frames).toHaveLength(2);
      const childBefore = before.frames.find((frame) =>
        frame.url.includes('/second.html'),
      );
      expect(childBefore).toBeDefined();

      const observation = await controller.observe();
      await controller.observe();
      const mid = (await controller.pages())[0];
      const childMid = mid.frames.find(
        (frame) => frame.frameId === childBefore?.frameId,
      );
      // Frame identity (id AND document) survives repeated observations.
      expect(childMid?.documentId).toBe(childBefore?.documentId);

      const swap = elementRef(observation, 'button', 'Swap frame source');
      await (await playwright.resolveElementRef(swap)).click();
      await expect
        .poll(
          async () =>
            (await controller.pages())[0]?.frames.find(
              (frame) => frame.frameId === childBefore?.frameId,
            )?.url ?? '',
          { timeout: 10_000 },
        )
        .toContain('/index.html');

      const after = (await controller.pages())[0];
      const childAfter = after.frames.find(
        (frame) => frame.frameId === childBefore?.frameId,
      );
      expect(childAfter?.documentId).not.toBe(childBefore?.documentId);
      // The main document was untouched by the frame's navigation.
      expect(after.documentId).toBe(before.documentId);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'diffs against recent baselines and degrades evicted ones to full snapshots',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/rows.html'));
      const first = await controller.observe();
      const reverseFirst = elementRef(first, 'button', 'Reverse rows');
      const mutate = elementRef(first, 'button', 'Add unrelated note');

      await (await playwright.resolveElementRef(mutate)).click();
      const second = await controller.observe({
        basedOnObservationId: first.page.observationId,
      });
      expect(second.changes.basis).toBe('requested_observation');
      expect(second.changes.navigated).toBe(false);
      expect(
        second.changes.newlyVisible.some((element) => element.name === 'Added later'),
      ).toBe(true);
      expect(second.changes.noLongerVisibleElementIds).toEqual([]);
      // Element identity is stable across observations of one document.
      expect(elementRef(second, 'button', 'Reverse rows').id).toBe(reverseFirst.id);

      await controller.goto(fixtureServer.url('/second.html'));
      const third = await controller.observe({
        basedOnObservationId: second.page.observationId,
      });
      expect(third.changes.basis).toBe('requested_observation');
      expect(third.changes.navigated).toBe(true);
      expect(third.changes.url).toEqual({
        before: fixtureServer.url('/rows.html'),
        after: fixtureServer.url('/second.html'),
      });
      expect(third.changes.noLongerVisibleElementIds).toContain(reverseFirst.id);

      // Push the first observation out of the diff cache…
      for (let i = 0; i < DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE; i += 1) {
        await controller.observe();
      }
      // …and asking for it yields a bounded full snapshot, never an error.
      const evicted = await controller.observe({
        basedOnObservationId: first.page.observationId,
      });
      expect(evicted.changes.basis).toBe('full_snapshot');
      expect(evicted.changes.navigated).toBe(false);
      expect(evicted.views[0]?.content).toContain('Second fixture page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'runs a receipted sequence with element and page-level keys, then settles',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/actions.html'));
      const observation = await controller.observe();
      const search = elementRef(observation, 'textbox', 'Search notes');

      const output = await controller.browserAction({
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        basedOnObservationId: observation.page.observationId,
        actions: [
          { op: 'fill', target: search, text: 'quarterly controls' },
          // No target: the key goes to the page, where the fill left focus.
          { op: 'press', key: 'Enter' },
          // Same key through an explicit target, proving both paths work.
          { op: 'press', target: search, key: 'Enter' },
        ],
        successChecks: [
          { type: 'text_present', text: 'Notes: searched quarterly controls' },
          { type: 'element_exists', role: 'button', name: 'Save draft' },
        ],
      });

      expect(output.status).toBe('completed');
      expect(output.actionReceipts.map((receipt) => receipt.op)).toEqual([
        'fill',
        'press',
        'press',
      ]);
      expect(output.actionReceipts.every((receipt) => receipt.effectsCommitted)).toBe(
        true,
      );
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([true, true]);
      expect(output.settled).toBe(true);
      expect(output.dialogs).toEqual([]);
      expect(output.openedPages).toEqual([]);
      expect(output.currentPage.observationId).toBe(
        observation.page.observationId + 1,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'waits for scroll-triggered content instead of a global network idle',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/lazy-load.html'));
      const observation = await controller.observe();

      const output = await controller.browserAction({
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        basedOnObservationId: observation.page.observationId,
        actions: [
          { op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } },
        ],
        successChecks: [{ type: 'text_present', text: 'All evidence loaded' }],
      });

      expect(output.status).toBe('completed');
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([true]);
      expect(output.settled).toBe(true);
      expect(output.changes.navigated).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'reports downloads a sequence started and passes the download_started check',
    async () => {
      await controller.newTab();
      // The fixture's download path needs the session cookie set by '/'.
      await controller.goto(fixtureServer.url('/'));
      await controller.goto(fixtureServer.url('/downloads.html'));
      const observation = await controller.observe();

      const output = await controller.browserAction({
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        basedOnObservationId: observation.page.observationId,
        actions: [
          {
            op: 'click',
            target: elementRef(
              observation,
              'button',
              'Generate download with JavaScript',
            ),
          },
        ],
        successChecks: [{ type: 'download_started' }],
      });

      expect(output.status).toBe('completed');
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([true]);
      expect(output.downloads).toHaveLength(1);
      expect(output.downloads[0]).toMatchObject({
        pageId: observation.page.pageId,
        suggestedFilename: 'javascript-evidence.bin',
      });
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'never admits download capture pages into the page registry',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));
      const before = (await controller.pages()).map((page) => page.pageId);

      await controller.download({
        url: fixtureServer.url('/browser-only-document.htm'),
      });

      expect((await controller.pages()).map((page) => page.pageId)).toEqual(before);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
