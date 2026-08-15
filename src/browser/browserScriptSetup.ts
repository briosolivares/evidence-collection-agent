import type { BrowserContext, Page } from 'playwright';

import type { BrowserScriptSetup } from './controller.js';
import type { PageRecord } from './playwrightBrowserController.js';

/** Only a loopback host is ever trusted as a CDP endpoint: it is read from a
 * file Chrome writes into a profile directory this process itself owns, and
 * treating anything else as equally trustworthy would be a privilege
 * escalation bug wearing a parsing bug's clothes. */
export const CDP_LOOPBACK_HOST = '127.0.0.1';

/** Require a CDP URL's host to be loopback. Shared by
 * `readDevToolsActivePortUrl` (in playwrightBrowserController.ts, which reads
 * the endpoint Chrome wrote to disk) and {@link prepareBrowserScriptTarget}'s
 * caller-facing contract so both sides of the browser-script handoff agree
 * on what counts as trustworthy. */
export function assertLoopbackCdpUrl(cdpUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new TypeError(`CDP URL is not a valid URL: ${cdpUrl}`);
  }
  if (parsed.hostname !== CDP_LOOPBACK_HOST && parsed.hostname !== 'localhost') {
    throw new TypeError(
      `CDP URL must use a loopback host, got ${JSON.stringify(parsed.hostname)}: ${cdpUrl}`,
    );
  }
}

/** Render any thrown value as a message fragment for an error string. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mechanics behind `PlaywrightBrowserController`'s conditionally-assigned
 * `prepareForBrowserScript` field — reachable only when the controller was
 * given a CDP endpoint.
 *
 * Attaches a throwaway CDP session to the resolved page (the requested
 * `pageId`, or the selected page when omitted, already resolved by the
 * caller) purely to read its PUBLIC target id via `Target.getTargetInfo`,
 * then detaches immediately; nothing here is held open past this call, and
 * no private Playwright field (`page._delegate`, `_targetId`, ...) is ever
 * touched.
 */
export async function prepareBrowserScriptTarget(
  context: BrowserContext,
  page: Page,
  cdpUrl: string,
): Promise<BrowserScriptSetup> {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return { cdpUrl, selectedPageTargetId: targetInfo.targetId };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Explicit collaborators {@link reconcileAfterBrowserScript} needs from the
 * controller, passed in rather than a controller reference so this module
 * never reaches into controller-private state directly. */
export interface BrowserScriptReconcileParams {
  context: BrowserContext;
  /** Pages that predate this controller and remain permanently excluded from
   * its registry. Managed sessions normally have one; attached Chrome can
   * have many user-owned tabs. */
  preexistingSessionPages: ReadonlySet<Page>;
  trackedPages: Map<Page, PageRecord>;
  createDocumentId: () => string;
  forgetPage: (pageId: string) => void;
  registerPage: (page: Page) => PageRecord;
  /** Optional ownership filter used by the URL-free v3 command path. The
   * legacy secondary-client script path omits it and adopts every non-
   * pre-existing page for backward compatibility. */
  shouldRegisterPage?: (page: Page) => Promise<boolean>;
  getActivePage: () => Page | undefined;
  setActivePage: (page: Page) => void;
}

/**
 * Mechanics behind `PlaywrightBrowserController`'s conditionally-assigned
 * `refreshAfterBrowserScript` field; see {@link prepareBrowserScriptTarget}
 * for why it is reachable only that way.
 *
 * Four steps, all reconciliation rather than rollback — a script's actions
 * are never undone:
 *
 * 1. Rescan `context.pages()` and register anything untracked.
 *    `registerPage` already dedupes by Page identity, so this is purely
 *    additive: a page the script opened should already be tracked through
 *    the controller constructor's `context.on('page')` listener, because CDP
 *    events reach every client attached to the same browser, including this
 *    controller's own connection. This rescan only closes a timing gap.
 * 2. Conservatively invalidate observation state for EVERY tracked page,
 *    using only mechanisms that already exist: rotate each tracked frame's
 *    documentId via `createDocumentId()` — exactly what the
 *    `framenavigated` handler does for a real navigation — so every
 *    pre-script `ElementRef` becomes stale and `resolveElementRef` rejects
 *    it, and drop each page's cached observation baselines via
 *    `forgetPage` so no diff can be computed against a since-mutated DOM. An
 *    external script can mutate the DOM with no navigation at all, which is
 *    exactly the case nothing else here would ever notice. This is
 *    deliberately conservative: at worst it forces a redundant
 *    re-observation, and it can NEVER cause a wrong-target action, because a
 *    stale ref is rejected rather than silently resolved to the wrong node.
 * 3. Reconcile the selected page. A still-live selection is left alone.
 *    This is the one behavior change confined to this refresh path: the
 *    ordinary `close` event handler leaves the active page undefined with no
 *    fallback (unchanged), but here a closed selection falls back to a
 *    remaining live tracked page, or a fresh task page when none remain, so
 *    the session stays usable after a script closes the tab it was handed.
 * 4. If the entire browser/context was closed by the script, fail loudly:
 *    recreating a session mid-run is out of scope, and every later browser
 *    tool stays unavailable for the rest of it.
 *
 * Idempotent: calling this again once controller state already matches the
 * live browser repeats step 2's invalidation (harmless — it can only force
 * another re-observation) and finds nothing to reconcile in steps 1 and 3.
 *
 * The caller is responsible for `requireOpenContext()` (the controller's
 * `closed` flag is private state this module never touches); this function
 * covers only the `context.isClosed()` check onward.
 */
export async function reconcileAfterBrowserScript(
  params: BrowserScriptReconcileParams,
): Promise<void> {
  const {
    context,
    preexistingSessionPages,
    trackedPages,
    createDocumentId,
    forgetPage,
    registerPage,
    shouldRegisterPage,
    getActivePage,
    setActivePage,
  } = params;

  if (context.isClosed()) {
    throw new Error(
      'The browser script closed the entire browser session (its BrowserContext is ' +
        'closed). Recreating a session mid-run is not supported: every later browser tool ' +
        'will be unavailable for the rest of this run.',
    );
  }

  let livePages: Page[];
  try {
    livePages = context.pages();
  } catch (error) {
    throw new Error(
      `The browser script left the browser session unusable: ${describeError(error)}. ` +
        'Recreating a session mid-run is not supported: every later browser tool will be ' +
        'unavailable for the rest of this run.',
    );
  }

  // Step 1. Pre-existing session pages are excluded exactly as they always
  // have been (see the controller's preexistingSessionPages option) —
  // this is the first code path that ever calls context.pages() directly,
  // and without the exclusion it would silently adopt that page into the
  // registry the moment any browser script ran.
  for (const page of livePages) {
    if (preexistingSessionPages.has(page)) {
      continue;
    }
    if (shouldRegisterPage !== undefined && !(await shouldRegisterPage(page))) {
      continue;
    }
    registerPage(page);
  }

  // Step 2.
  for (const record of trackedPages.values()) {
    for (const frameRecord of record.frames.values()) {
      frameRecord.documentId = createDocumentId();
    }
    forgetPage(record.pageId);
  }

  // Step 3 (and step 4's newPage fallback).
  const activePage = getActivePage();
  if (activePage === undefined || activePage.isClosed()) {
    const liveTracked = [...trackedPages.values()].filter(
      (record) => !record.page.isClosed(),
    );
    if (liveTracked.length > 0) {
      setActivePage(liveTracked[0]!.page);
    } else {
      try {
        const page = await context.newPage();
        registerPage(page);
        setActivePage(page);
      } catch (error) {
        throw new Error(
          `The browser script left the browser session unusable: ${describeError(error)}. ` +
            'Recreating a session mid-run is not supported: every later browser tool will ' +
            'be unavailable for the rest of this run.',
        );
      }
    }
  }
}
