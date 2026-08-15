import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import {
  DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE,
  type BrowserObservation,
  type ElementRef,
} from './browserState.js';
import {
  assertBrowserScriptSupportIsPaired,
  BrowserRefNotFoundError,
  type BrowserController,
  type BrowserScriptSetup,
} from './controller.js';
import { toEarlyJavaScriptRequest } from './browserJavaScript.js';
import {
  LocalChromeBrowserSessionProvider,
  PlaywrightBrowserController,
} from './playwrightBrowserController.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BROWSER_TEST_TIMEOUT_MS = 15_000;

/**
 * Close a tracked page for suite hygiene, WITHOUT ever selecting it: with
 * `switch_page` gone, production has no way to close a page other than the
 * active task tab, so a test that opens an extra page (a popup) closes it
 * exactly as an external browser script would — over the SAME loopback CDP
 * endpoint `prepareForBrowserScript` exposes, addressed by `pageId` alone.
 * This never touches this controller's own selected pointer.
 */
async function closeTrackedPageForCleanup(
  controller: BrowserController,
  pageId: string,
): Promise<void> {
  const setup = await controller.prepareForBrowserScript!(pageId);
  const remote = await chromium.connectOverCDP(setup.cdpUrl);
  try {
    for (const context of remote.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page);
        try {
          const { targetInfo } = await session.send('Target.getTargetInfo');
          if (targetInfo.targetId === setup.selectedPageTargetId) {
            await page.close();
            return;
          }
        } finally {
          await session.detach().catch(() => undefined);
        }
      }
    }
    throw new Error(`closeTrackedPageForCleanup: no live page matches target id ${setup.selectedPageTargetId}`);
  } finally {
    await remote.close();
  }
}

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
    'preserves an outline ref across consecutive calls on an unchanged page',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

      const firstOutline = await controller.outline();
      const buttonRef = refFor(firstOutline, 'button "Announce ready"');
      const secondOutline = await controller.outline();

      expect(refFor(secondOutline, 'button "Announce ready"')).toBe(buttonRef);
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
    'captures the selected page as PNG bytes',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));

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
    'captures a page and an element as exact text with the identity to re-read it',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));
      const observation = await controller.observe();

      const page = await playwright.captureText();
      // Rendered text, whole — not the outline, which normalizes the
      // paragraph away, and not a bounded view.
      expect(page.text).toContain('Browser controller fixture');
      expect(page.text).toContain(
        'This deterministic page exercises semantic browser observations.',
      );
      expect(page).toMatchObject({
        locator: 'body',
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        url: fixtureServer.url('/'),
        title: 'Browser Controller Fixture',
        observationId: observation.page.observationId,
      });

      // A text-only observation records NO elements, so an id-to-ref lookup
      // that only consulted the latest observation would lose a ref the
      // caller legitimately still holds.
      await controller.observe({ need: ['text'] });
      const announce = elementRef(observation, 'button', 'Announce ready');
      const element = await playwright.captureText({ elementId: announce.id });
      expect(element.text).toBe('Announce ready');
      expect(element.documentId).toBe(announce.documentId);
      expect(element.locator).not.toBe('body');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to capture an unknown element id, or one whose document is gone',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));
      const observation = await controller.observe();
      const announce = elementRef(observation, 'button', 'Announce ready');

      await expect(
        playwright.captureText({ elementId: 'el-does-not-exist' }),
      ).rejects.toBeInstanceOf(BrowserRefNotFoundError);

      // Navigation replaces the document, so the text that ref named is no
      // longer on screen — a capture must never quote a page that is gone.
      await controller.goto(fixtureServer.url('/second.html'));
      await expect(
        playwright.captureText({ elementId: announce.id }),
      ).rejects.toBeInstanceOf(BrowserRefNotFoundError);
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
    'tracks popup identity across observations, addressed by pageId with no selection change',
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

      // Identity survives more than one observation of the popup — reached
      // entirely by pageId, with no `switch_page` to move a selection.
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

      // The popup's own identity (title) is reachable by pageId too, and
      // reading it never moves the selected pointer off the task tab.
      expect(await controller.title(popup?.pageId)).toBe('Second Fixture Page');
      const stillMain = (await controller.pages()).find(
        (page) => page.pageId === main?.pageId,
      );
      expect(stillMain?.active).toBe(true);
      expect(controller.currentUrl()).toBe(fixtureServer.url('/popup.html'));

      await closeTrackedPageForCleanup(controller, popup!.pageId);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'lists sibling pages on an observation only when more than one page is open',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/popup.html'));

      // A single live page: the sibling listing is omitted entirely, not an
      // empty array — the common case pays nothing for it.
      const solo = await controller.observe();
      expect(solo.otherOpenPages).toBeUndefined();

      const opener = elementRef(solo, 'link', 'Open popup fixture');
      await (await playwright.resolveElementRef(opener)).click();
      await expect
        .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
        .toBe(2);
      const popup = (await controller.pages()).find((page) => page.pageId !== solo.page.pageId);
      expect(popup).toBeDefined();
      await expect
        .poll(
          async () =>
            (await controller.pages()).find((page) => page.pageId === popup?.pageId)
              ?.url ?? '',
          { timeout: 10_000 },
        )
        .toContain('/second.html');

      const withPopup = await controller.observe();
      expect(withPopup.otherOpenPages).toHaveLength(1);
      expect(withPopup.otherOpenPages?.[0]).toMatchObject({
        pageId: popup?.pageId,
        title: 'Second Fixture Page',
      });
      expect(withPopup.otherOpenPages?.[0]?.url).toContain('/second.html');
      // The sibling listing never names the observed page itself.
      expect(withPopup.otherOpenPages?.[0]?.pageId).not.toBe(withPopup.page.pageId);

      // Observing the POPUP instead reports the main tab as its one sibling.
      const fromPopup = await controller.observe({ pageId: popup!.pageId });
      expect(fromPopup.otherOpenPages).toHaveLength(1);
      expect(fromPopup.otherOpenPages?.[0]?.pageId).toBe(solo.page.pageId);

      await closeTrackedPageForCleanup(controller, popup!.pageId);
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

  it(
    'tells a caller who passed an element id rather than an outline ref exactly that',
    async () => {
      await controller.newTab();
      await controller.goto(fixtureServer.url('/'));
      const observation = await controller.observe({ need: ['interactive'] });
      const [element] = observation.elements;
      if (element === undefined) {
        throw new Error('the fixture page produced no interactive elements');
      }

      // `elements[].id` is browserAction's handle; download takes the
      // `[ref=…]` outline stamp. The two are easy to confuse because one
      // observation hands back both, so the error has to name the difference:
      // observing again returns this very same id, which makes the default
      // "inspect the page again" advice a loop rather than a fix.
      const failure: unknown = await controller
        .download({ ref: element.id })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BrowserRefNotFoundError);
      expect((failure as Error).message).toContain('not an outline ref');
      expect((failure as Error).message).not.toContain('inspect the page again');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  describe('PlaywrightBrowserController.pdfPageSource', () => {
    it(
      'hands out a page factory whose pages can never navigate the selected page away',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const selectedUrlBefore = controller.currentUrl();
        const pagesBefore = (await controller.pages()).map((page) => page.pageId);

        const pageSource = playwright.pdfPageSource();
        const renderPage = await pageSource.newPage();
        try {
          // The render page is a real, working page — it can navigate and
          // load content on its own, independent of the worker's tab.
          await renderPage.goto(fixtureServer.url('/second.html'));
          expect(renderPage.url()).toBe(fixtureServer.url('/second.html'));
          expect(await renderPage.title()).toBe('Second Fixture Page');

          // The whole point: opening and driving the render page must never
          // move the worker's own selected tab.
          expect(controller.currentUrl()).toBe(selectedUrlBefore);
        } finally {
          await renderPage.close();
        }

        // Deliberately not tracked: a render page must never become
        // selectable, so the registry's page list is untouched by its
        // whole lifecycle (open, navigate, close).
        expect((await controller.pages()).map((page) => page.pageId)).toEqual(pagesBefore);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'throws once the browser session is closed',
      async () => {
        const standaloneProfileDir = await mkdtemp(
          join(tmpdir(), 'evidence-agent-chrome-pdf-page-source-'),
        );
        const standaloneProvider = new LocalChromeBrowserSessionProvider({
          profileDir: standaloneProfileDir,
          headless: true,
        });
        const standalone = (await standaloneProvider.createSession()) as PlaywrightBrowserController;
        try {
          await standalone.newTab();
          // Sanity: works normally before close, so the throw below is
          // actually about closing, not about some other precondition.
          expect(() => standalone.pdfPageSource()).not.toThrow();

          await standalone.close();

          expect(() => standalone.pdfPageSource()).toThrow(/closed/);
        } finally {
          await standalone.close().catch(() => undefined);
          await rm(standaloneProfileDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  });

  describe('PlaywrightBrowserController.executeJavaScript', () => {
    it(
      'bulk-extracts a repeated list in one call, with the document URL and a token',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest(
            'return Array.from(document.querySelectorAll("a")).map((a) => ({ text: a.textContent.trim(), href: a.href }));',
            5_000,
          ),
        );

        expect(Array.isArray(result.value)).toBe(true);
        expect((result.value as unknown[]).length).toBeGreaterThan(0);
        expect(result.url).toBe(fixtureServer.url('/'));
        expect(result.documentToken).toMatch(/^doc-/);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    // Every other test in this describe passes `return X;` — the one form that
    // worked under the old wrapping, which is why 15-of-15 live failures went
    // unnoticed. These cover the forms a person actually writes.
    it(
      'returns the value of a bare expression',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('document.querySelectorAll("a").length', 5_000),
        );

        expect(typeof result.value).toBe('number');
        expect(result.value as number).toBeGreaterThan(0);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'returns the value of a self-invoking function, trailing semicolon and all',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest(
            '(function () {\n  const links = document.querySelectorAll("a");\n  return { count: links.length };\n})();',
            5_000,
          ),
        );

        expect(result.value).toMatchObject({ count: expect.any(Number) });
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'supports await at the top level of the snippet',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('await Promise.resolve(7)', 5_000),
        );

        expect(result.value).toBe(7);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'returns the completion value of a statement body ending in a bare expression',
      async () => {
        // Was pinned as a known limitation ("needs a real parser"), until a
        // live run showed this is the FIRST shape a model writes for a real
        // extraction — statements building a result, named on the last line.
        // V8 is the parser: new Function compiles without executing.
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('const n = document.querySelectorAll("a").length;\nn;', 5_000),
        );

        expect(typeof result.value).toBe('number');
        expect(result.value as number).toBeGreaterThan(0);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'returns the completion value of the exact snippet the live run failed on',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest(
            '\nconst rows = Array.from(document.querySelectorAll("a")).slice(0, 3);\n' +
              'const results = rows.map((row) => ({ text: row.textContent.trim() }));\n' +
              'results;\n',
            5_000,
          ),
        );

        expect(Array.isArray(result.value)).toBe(true);
        expect((result.value as unknown[]).length).toBeGreaterThan(0);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'never turns a loop body into an early return while chasing a completion value',
      async () => {
        // `for (const x of xs) f(x)` splits into a head that does not parse on
        // its own, so the candidate is rejected. Were it accepted, the joined
        // form would parse and mean "return on the first iteration" — the
        // silent meaning change that kept this rewrite out of the code before.
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest(
            'const seen = [];\nfor (const a of document.querySelectorAll("a")) seen.push(a.href)\n' +
              'return seen.length;',
            5_000,
          ),
        );

        // Every anchor visited, not just the first.
        expect(result.value).toBe(
          (
            await controller.executeJavaScript!(
              toEarlyJavaScriptRequest('document.querySelectorAll("a").length', 5_000),
            )
          ).value,
        );
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'never runs a snippet twice when it throws at runtime',
      async () => {
        // The fallback exists for PARSE failures, where nothing ran. A snippet
        // that parsed and then threw has already had its side effects; running
        // it again could double-submit a form or double-click a button.
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));

        // Valid as an expression, so it runs on the FIRST attempt and throws.
        await expect(
          controller.executeJavaScript!(
            toEarlyJavaScriptRequest(
              '(() => { window.__runs = (window.__runs || 0) + 1; throw new Error("boom"); })()',
              5_000,
            ),
          ),
        ).rejects.toThrow(/boom/);

        const runs = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('window.__runs', 5_000),
        );
        expect(runs.value).toBe(1);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'runs a snippet once when only the expression wrapping fails to parse',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));

        // `const` cannot appear in expression position, so attempt 1 is a
        // SyntaxError that executed nothing; attempt 2 runs the body once.
        await expect(
          controller.executeJavaScript!(
            toEarlyJavaScriptRequest(
              'const before = window.__fallback || 0;\nwindow.__fallback = before + 1;\nthrow new Error("after the side effect");',
              5_000,
            ),
          ),
        ).rejects.toThrow(/after the side effect/);

        const runs = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('window.__fallback', 5_000),
        );
        expect(runs.value).toBe(1);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'captures console output from the snippet',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const result = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('console.log("from the page"); return 1;', 5_000),
        );
        expect(result.logs.join('\n')).toContain('from the page');
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'gives a navigation a new document token, so two same-URL calls are distinguishable',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const first = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('return 1;', 5_000),
        );
        // Same tab, navigated again: a fresh document in the same page.
        await controller.goto(fixtureServer.url('/'));
        const second = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('return 1;', 5_000),
        );
        // Same URL, different document — which is exactly what the token is for.
        expect(second.url).toBe(first.url);
        expect(second.documentToken).not.toBe(first.documentToken);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'terminates a spinning snippet and leaves the run usable after replacement',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        await expect(
          controller.executeJavaScript!(
            toEarlyJavaScriptRequest('while (true) {}', 1_000),
          ),
        ).rejects.toMatchObject({ name: 'BrowserJavaScriptTimeoutError' });

        // The page's event loop is not trustworthy after that, so it is replaced
        // rather than reused — and the session keeps working.
        // replaceUnresponsivePage already selected a fresh page — asking for
        // another tab here would be the "already active" error, and the point
        // is that the session is immediately usable again.
        await controller.replaceUnresponsivePage!();
        await controller.goto(fixtureServer.url('/second.html'));
        expect(controller.currentUrl()).toBe(fixtureServer.url('/second.html'));
      },
      BROWSER_TEST_TIMEOUT_MS * 2,
    );

    it(
      'fails renderer reads on a wedged page instead of waiting forever',
      async () => {
        // The live hang: a page whose main thread is saturated makes
        // page.evaluate / title / ariaSnapshot wait indefinitely, because none
        // of them accepts a timeout. A .catch() on those calls bounds a
        // rejection, not a hang, so several reads only LOOKED protected. Here
        // the renderer is genuinely wedged, and every read must still settle.
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        await expect(
          controller.executeJavaScript!(toEarlyJavaScriptRequest('while (true) {}', 1_000)),
        ).rejects.toMatchObject({ name: 'BrowserJavaScriptTimeoutError' });

        // A listing degrades: the title is survivable, so it comes back empty
        // rather than failing the whole call.
        const listed = await controller.pages();
        expect(listed.length).toBeGreaterThan(0);

        // An observation does NOT degrade: a silently truncated outline would
        // be worse than an error, so it rejects and says what to do.
        await expect(controller.observe()).rejects.toThrow(/stopped responding/);

        await controller.replaceUnresponsivePage!();
        await controller.goto(fixtureServer.url('/second.html'));
        expect(controller.currentUrl()).toBe(fixtureServer.url('/second.html'));
      },
      BROWSER_TEST_TIMEOUT_MS * 4,
    );

    it(
      'surfaces a page-thrown error without replacing the page',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        await expect(
          controller.executeJavaScript!(
            toEarlyJavaScriptRequest('throw new Error("snippet blew up");', 5_000),
          ),
        ).rejects.toThrow(/snippet blew up/);

        // An ordinary throw is the snippet's fault, not the page's: the page
        // stays usable.
        const after = await controller.executeJavaScript!(
          toEarlyJavaScriptRequest('return 42;', 5_000),
        );
        expect(after.value).toBe(42);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  });

  describe('browser scripts (prepareForBrowserScript / refreshAfterBrowserScript)', () => {
    // The exact file:// URL a real worker would put in
    // SHERLOCK_PLAYWRIGHT_HELPER_URL: this file's own sibling module.
    const HELPER_URL = new URL('./browserScriptHelper.mjs', import.meta.url).href;
    let scriptDir: string;

    beforeAll(async () => {
      scriptDir = await mkdtemp(join(tmpdir(), 'evidence-agent-browser-script-'));
    });

    afterAll(async () => {
      await rm(scriptDir, { recursive: true, force: true });
    });

    /**
     * Write and run a generated browser script exactly as the real worker
     * would: a standalone Node ESM file importing `connectSelectedPage` from
     * the SAME file:// URL a worker puts in `SHERLOCK_PLAYWRIGHT_HELPER_URL`,
     * spawned as its OWN process with the three `SHERLOCK_*` variables set
     * from a real `prepareForBrowserScript()` result.
     *
     * Spawned as a real child process — the actual isolation boundary a
     * generated script runs under, with no access to this test file's
     * in-process state — rather than imported directly, so this exercises
     * the whole contract end to end, including that the helper resolves
     * Playwright from the application package while running from a scratch
     * directory with no `node_modules` of its own.
     */
    async function runBrowserScript(
      setup: BrowserScriptSetup,
      scriptBody: string,
      timeoutMs = 8_000,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
      const scriptPath = join(scriptDir, `script-${Math.random().toString(36).slice(2)}.mjs`);
      await writeFile(
        scriptPath,
        `import { connectSelectedPage } from ${JSON.stringify(HELPER_URL)};\n${scriptBody}\n`,
        'utf8',
      );

      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [scriptPath], {
          env: {
            ...process.env,
            SHERLOCK_PLAYWRIGHT_HELPER_URL: HELPER_URL,
            SHERLOCK_CDP_URL: setup.cdpUrl,
            SHERLOCK_SELECTED_PAGE_TARGET_ID: setup.selectedPageTargetId,
          },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          rejectPromise(new Error(`Browser script timed out after ${timeoutMs}ms.\n${stderr}`));
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(error);
        });
        child.on('close', (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise({ stdout, stderr, exitCode });
        });
      });
    }

    it(
      'exposes a loopback CDP endpoint and the selected page CDP target id',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        expect(() => assertBrowserScriptSupportIsPaired(controller)).not.toThrow();

        const setup = await controller.prepareForBrowserScript!();
        const parsed = new URL(setup.cdpUrl);
        expect(parsed.protocol).toBe('http:');
        expect(parsed.hostname).toBe('127.0.0.1');
        expect(typeof setup.selectedPageTargetId).toBe('string');
        expect(setup.selectedPageTargetId.length).toBeGreaterThan(0);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'connects the helper to exactly the named page, never a different open tab',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/popup.html'));
        const main = (await controller.pages()).find((page) => page.active);
        const observation = await controller.observe();
        const opener = elementRef(observation, 'link', 'Open popup fixture');
        await (await playwright.resolveElementRef(opener)).click();
        await expect
          .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
          .toBe(2);
        const popup = (await controller.pages()).find((page) => page.pageId !== main?.pageId);
        expect(popup).toBeDefined();

        // Prepare against the POPUP's pageId explicitly; main stays selected
        // throughout (there is no switch_page to move it). A helper that
        // ever fell back to "the selected page" — or to "the first open
        // tab" — would silently connect to main instead, and naming the
        // popup here makes that failure mode visible rather than
        // accidentally passing.
        const setup = await controller.prepareForBrowserScript!(popup!.pageId);
        const { stdout, stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "console.log(JSON.stringify({ url: page.url(), title: await page.title() }));\n" +
            // The script closes the page it was handed itself: with no
            // switch_page, this is how a test (or a real script) tears down
            // a popup it is done with, never by selecting it first.
            "await page.close();\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);
        expect(JSON.parse(stdout.trim())).toMatchObject({
          url: fixtureServer.url('/second.html'),
          title: 'Second Fixture Page',
        });

        // Main was never touched: still selected, still on popup.html.
        expect(controller.currentUrl()).toBe(fixtureServer.url('/popup.html'));

        await controller.refreshAfterBrowserScript!();
        await expect
          .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
          .toBe(1);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'performs a Playwright locator click/fill/wait/extraction through the secondary connection',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/actions.html'));
        const setup = await controller.prepareForBrowserScript!();

        const { stdout, stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "await page.locator('#full-name').fill('Ada Lovelace');\n" +
            "await page.locator('#save').click();\n" +
            "await page.waitForSelector('#status:has-text(\"Draft saved\")');\n" +
            "const status = await page.locator('#status').innerText();\n" +
            "console.log(JSON.stringify({ status }));\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);
        expect(JSON.parse(stdout.trim()).status).toContain('Draft saved for Ada Lovelace');

        await controller.refreshAfterBrowserScript!();
        expect(await controller.title()).toBe('Browser Action Fixture');
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'gives observe() a fresh outline and rejects a pre-script ref after refresh',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/rows.html'));
        const before = await controller.observe();
        const staleRef = elementRef(before, 'button', 'Reverse rows');

        const setup = await controller.prepareForBrowserScript!();
        const { stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "await page.locator('#mutate').click();\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);

        await controller.refreshAfterBrowserScript!();

        // The pre-script ref is stale: refreshAfterBrowserScript rotated the
        // frame's documentId exactly as a real navigation would, even though
        // the script never navigated the page at all.
        await expect(playwright.resolveElementRef(staleRef)).rejects.toBeInstanceOf(
          BrowserRefNotFoundError,
        );

        // observe() sees what the script actually did, and re-mints a fresh,
        // resolvable ref with a NEW documentId for the same element.
        const text = await controller.observe({ need: ['text'] });
        expect(text.views[0]?.content).toContain('Added later');
        const interactive = await controller.observe();
        const freshRef = elementRef(interactive, 'button', 'Reverse rows');
        expect(freshRef.documentId).not.toBe(staleRef.documentId);
        await (await playwright.resolveElementRef(freshRef)).click();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'reconciles a popup the script opened into the tracked pages, without duplicating it',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/popup.html'));
        expect(await controller.pages()).toHaveLength(1);

        const setup = await controller.prepareForBrowserScript!();
        const { stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, context, page } = await connectSelectedPage();\n" +
            "const [popup] = await Promise.all([\n" +
            "  context.waitForEvent('page'),\n" +
            "  page.click('a'),\n" +
            "]);\n" +
            "await popup.waitForLoadState();\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);

        // The primary connection's own 'page' listener observes the same CDP
        // events as the script's secondary one, so this should already be
        // tracked in real time — asserted before refresh runs at all.
        await expect
          .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
          .toBe(2);

        // refreshAfterBrowserScript's rescan is additive/idempotent: it must
        // not duplicate the popup it (at most) rediscovers.
        await controller.refreshAfterBrowserScript!();
        const pages = await controller.pages();
        expect(pages).toHaveLength(2);
        const popupPage = pages.find((page) => page.url.includes('/second.html'));
        expect(popupPage).toBeDefined();
        // Main was never selected away from popup.html: nothing above ever
        // named it, since there is no switch_page to move the pointer.
        expect(pages.find((page) => page.active)?.url).toContain('/popup.html');

        // Cleanup for later tests: close the popup by pageId, the same way a
        // browser script would, without ever selecting it.
        await closeTrackedPageForCleanup(controller, popupPage!.pageId);
        await expect
          .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
          .toBe(1);
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'reconciles the selected page to a remaining live tracked page when the script closes it',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/popup.html'));
        const observation = await controller.observe();
        const opener = elementRef(observation, 'link', 'Open popup fixture');
        await (await playwright.resolveElementRef(opener)).click();
        await expect
          .poll(async () => (await controller.pages()).length, { timeout: 10_000 })
          .toBe(2);
        // Main (popup.html) stays selected going into prepare.

        const setup = await controller.prepareForBrowserScript!();
        const { stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "await page.close();\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);

        // Poll refresh+pages() together: the primary connection's own
        // isClosed() bookkeeping updates asynchronously as CDP delivers the
        // close notification, independent of when the script's own process
        // exited.
        await expect
          .poll(
            async () => {
              await controller.refreshAfterBrowserScript!();
              const pages = await controller.pages();
              return pages.length === 1 && pages[0]?.active ? pages[0]?.url : undefined;
            },
            { timeout: 10_000 },
          )
          .toBe(fixtureServer.url('/second.html'));
        expect(controller.currentUrl()).toBe(fixtureServer.url('/second.html'));
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'reconciles to a fresh task page when the script closes the only tracked page',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const setup = await controller.prepareForBrowserScript!();
        const { stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "await page.close();\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);

        await expect
          .poll(
            async () => {
              await controller.refreshAfterBrowserScript!();
              const pages = await controller.pages();
              return pages.length === 1 && pages[0]?.active ? pages[0]?.url : undefined;
            },
            { timeout: 10_000 },
          )
          .toBe('about:blank');
        expect(controller.currentUrl()).toBe('about:blank');

        // The controller is fully usable afterward: the fallback page is a
        // real, ordinary task tab, not a dead end.
        await controller.goto(fixtureServer.url('/second.html'));
        expect(await controller.title()).toBe('Second Fixture Page');
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'lets the secondary client disconnect without closing the shared browser',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const setup = await controller.prepareForBrowserScript!();
        const { stderr, exitCode } = await runBrowserScript(
          setup,
          "const { browser, page } = await connectSelectedPage();\n" +
            "console.log(await page.title());\n" +
            "await browser.close();",
        );
        expect(exitCode, stderr).toBe(0);

        await controller.refreshAfterBrowserScript!();
        // The SAME controller, same shared Chrome: the secondary client's
        // own browser.close() (a disconnect, not a kill, for a Browser
        // obtained via connectOverCDP — see the helper's contract) never
        // touched the browser this controller still owns.
        await controller.goto(fixtureServer.url('/second.html'));
        expect(await controller.title()).toBe('Second Fixture Page');
        expect(controller.currentUrl()).toBe(fixtureServer.url('/second.html'));
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'is idempotent across repeated prepare/refresh cycles with no script in between',
      async () => {
        await controller.newTab();
        await controller.goto(fixtureServer.url('/'));
        const first = await controller.prepareForBrowserScript!();
        await controller.refreshAfterBrowserScript!();
        await controller.refreshAfterBrowserScript!();
        const second = await controller.prepareForBrowserScript!();
        await controller.refreshAfterBrowserScript!();

        expect(second.cdpUrl).toBe(first.cdpUrl);
        expect(second.selectedPageTargetId).toBe(first.selectedPageTargetId);
        expect(await controller.pages()).toHaveLength(1);
        expect(controller.currentUrl()).toBe(fixtureServer.url('/'));
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

    it(
      'fails refreshAfterBrowserScript loudly when the script closes the whole browser',
      async () => {
        const standaloneProfileDir = await mkdtemp(
          join(tmpdir(), 'evidence-agent-chrome-standalone-'),
        );
        const standaloneProvider = new LocalChromeBrowserSessionProvider({
          profileDir: standaloneProfileDir,
          headless: true,
        });
        const standalone = await standaloneProvider.createSession();
        try {
          await standalone.newTab();
          await standalone.goto(fixtureServer.url('/'));
          const setup = await standalone.prepareForBrowserScript!();

          const { stderr, exitCode } = await runBrowserScript(
            setup,
            "const { context, page } = await connectSelectedPage();\n" +
              "const session = await context.newCDPSession(page);\n" +
              "await session.send('Browser.close').catch(() => undefined);\n" +
              "process.exit(0);",
          );
          expect(exitCode, stderr).toBe(0);

          await expect
            .poll(
              async () => {
                try {
                  await standalone.refreshAfterBrowserScript!();
                  return 'did not throw';
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
              { timeout: 10_000 },
            )
            .toMatch(/browser (has been disconnected|session|script)/i);
        } finally {
          await standalone.close().catch(() => undefined);
          await rm(standaloneProfileDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 3,
    );
  });
});

describe('assertBrowserScriptSupportIsPaired', () => {
  function stubSetup(): BrowserScriptSetup {
    return { cdpUrl: 'http://127.0.0.1:9', selectedPageTargetId: 'target-1' };
  }

  it('accepts a controller offering neither method', () => {
    const bare = {} as BrowserController;
    expect(() => assertBrowserScriptSupportIsPaired(bare)).not.toThrow();
  });

  it('accepts a controller offering both methods', () => {
    const both = {
      prepareForBrowserScript: async () => stubSetup(),
      refreshAfterBrowserScript: async () => undefined,
    } as unknown as BrowserController;
    expect(() => assertBrowserScriptSupportIsPaired(both)).not.toThrow();
  });

  it('rejects a controller offering only prepareForBrowserScript', () => {
    const onlyPrepare = {
      prepareForBrowserScript: async () => stubSetup(),
    } as unknown as BrowserController;
    expect(() => assertBrowserScriptSupportIsPaired(onlyPrepare)).toThrow(/half-implemented/);
  });

  it('rejects a controller offering only refreshAfterBrowserScript', () => {
    const onlyRefresh = {
      refreshAfterBrowserScript: async () => undefined,
    } as unknown as BrowserController;
    expect(() => assertBrowserScriptSupportIsPaired(onlyRefresh)).toThrow(/half-implemented/);
  });
});
