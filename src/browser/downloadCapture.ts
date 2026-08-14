/**
 * Download capture.
 *
 * Owns the two strategies {@link PlaywrightBrowserController.download} picks
 * between: navigating a throwaway page straight to a URL
 * ({@link captureUrlThroughChrome}), and clicking a resolved element and
 * waiting for the download it triggers ({@link captureClickDownload}). Split
 * out because both are self-contained once handed a page (or a context to
 * make one) — neither needs any other controller state.
 */
import type { BrowserContext, Download, Locator, Page, Response } from 'playwright';

import type { BrowserDownloadResult } from './controller.js';
import { normalizeRefActionError } from './pageElementRefs.js';
import { delay, isHttpUrl } from './playwrightBrowserController.js';

const DOWNLOAD_EVENT_TIMEOUT_MS = 5_000;
const DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS = 1_000;

/**
 * Capture a download (or navigation response) reached by navigating
 * directly to `url`, without disturbing `referringPage`.
 *
 * Opens a throwaway page for the navigation — the caller's own page never
 * navigates away from what it is showing. The throwaway page must be kept
 * out of the controller's page registry (it is plumbing, not a task tab),
 * which is what `trackPendingInternalPage`/`untrackPendingInternalPage`
 * exist to do: they mirror exactly the `pendingInternalPages` counter
 * interaction the controller's `context.on('page')` listener reads, so a
 * page opened here is counted out of registration instead of appearing in
 * `pages()`.
 *
 * @param trackPendingInternalPage - call BEFORE opening the throwaway page,
 *   so the listener sees the counter already incremented when the page event
 *   fires
 * @param untrackPendingInternalPage - call ONLY when `context.newPage()`
 *   itself failed before (or, vanishingly rarely, after) its `page` event —
 *   rebalances the counter without going negative, so a later popup cannot
 *   be misclassified as internal
 */
export async function captureUrlThroughChrome(
  context: BrowserContext,
  url: string,
  referringPage: Page,
  trackPendingInternalPage: () => void,
  untrackPendingInternalPage: () => void,
): Promise<BrowserDownloadResult> {
  const referringUrl = referringPage.url();
  // A throwaway plumbing page: counted out of the page registry (see the
  // controller constructor's 'page' listener) so pages() never shows it and
  // no identity is ever bound to it.
  trackPendingInternalPage();
  let capturePage: Page;
  try {
    capturePage = await context.newPage();
  } catch (error) {
    // newPage failed before (or, vanishingly rarely, after) its 'page'
    // event; rebalance without going negative so a later popup cannot be
    // misclassified as internal.
    untrackPendingInternalPage();
    throw error;
  }

  try {
    const downloadOutcome = capturePage
      .waitForEvent('download', { timeout: 0 })
      .then((download) => ({ kind: 'download' as const, download }));
    const navigationOutcome = capturePage
      .goto(url, {
        waitUntil: 'commit',
        ...(isHttpUrl(referringUrl) ? { referer: referringUrl } : {}),
      })
      .then(
        (response) => ({ kind: 'response' as const, response }),
        (error: unknown) => ({ kind: 'navigation_error' as const, error }),
      );

    const outcome = await Promise.race([downloadOutcome, navigationOutcome]);
    if (outcome.kind === 'download') {
      return await readBrowserDownload(outcome.download);
    }

    if (outcome.kind === 'response') {
      if (outcome.response === null) {
        throw new Error(`Browser navigation produced no response: ${url}`);
      }
      return await readNavigationResponse(outcome.response);
    }

    const lateDownload = await Promise.race([
      downloadOutcome,
      delay(DOWNLOAD_AFTER_NAVIGATION_ERROR_GRACE_MS).then(() => undefined),
    ]);
    if (lateDownload !== undefined) {
      return await readBrowserDownload(lateDownload.download);
    }
    throw outcome.error;
  } finally {
    await capturePage.close();
  }
}

export async function captureClickDownload(
  locator: Locator,
  ref: string,
  page: Page,
): Promise<BrowserDownloadResult> {
  const downloadPromise = page.waitForEvent('download', {
    timeout: DOWNLOAD_EVENT_TIMEOUT_MS,
  });
  void downloadPromise.catch(() => undefined);
  let clickCompleted = false;

  try {
    await locator.click();
    clickCompleted = true;
    return await readBrowserDownload(await downloadPromise);
  } catch (error) {
    if (!clickCompleted) {
      throw await normalizeRefActionError(locator, ref, error);
    }
    throw new Error(
      `Browser ref ${ref} has no HTTP(S) href and did not start a browser download. ` +
        'Observe the page again and choose a download link or control, or pass a verified direct URL.',
    );
  }
}

async function readNavigationResponse(
  response: Response,
): Promise<BrowserDownloadResult> {
  const headers = response.headers();
  return {
    finalUrl: response.url(),
    status: response.status(),
    headers,
    bytes: new Uint8Array(await response.body()),
    ...(suggestedFilenameFromHeaders(headers) !== undefined
      ? { suggestedFilename: suggestedFilenameFromHeaders(headers) }
      : {}),
  };
}

async function readBrowserDownload(
  download: Download,
): Promise<BrowserDownloadResult> {
  const failure = await download.failure();
  if (failure !== null) {
    throw new Error(`Browser download failed: ${failure}`);
  }

  const stream = await download.createReadStream();
  if (stream === null) {
    throw new Error('Browser download completed without a readable byte stream.');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    finalUrl: download.url(),
    headers: {},
    bytes: new Uint8Array(Buffer.concat(chunks)),
    suggestedFilename: download.suggestedFilename(),
  };
}

function suggestedFilenameFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const disposition = headers['content-disposition'];
  if (disposition === undefined) return undefined;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      return encoded.trim();
    }
  }

  return disposition.match(/filename="([^"]+)"/i)?.[1]
    ?? disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
}
