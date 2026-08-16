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
import type { BrowserDownloadReader } from './downloadReader.js';
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
 * @param downloadReader - how to turn a download EVENT into bytes; local
 *   Chrome reads the file it already wrote, a remote browser has to fetch it
 *   back (see downloadReader.ts). Direct-navigation responses never reach it:
 *   those already carry their bytes in-process, which is why that path is
 *   deliberately left untouched by provider choice.
 */
export async function captureUrlThroughChrome(
  context: BrowserContext,
  url: string,
  referringPage: Page,
  trackPendingInternalPage: () => void,
  untrackPendingInternalPage: () => void,
  downloadReader: BrowserDownloadReader,
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
      return await readBrowserDownload(outcome.download, downloadReader);
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
      return await readBrowserDownload(lateDownload.download, downloadReader);
    }
    throw outcome.error;
  } finally {
    await capturePage.close();
  }
}

export async function captureClickDownload(
  locator: Locator,
  targetDescription: string,
  page: Page,
  downloadReader: BrowserDownloadReader,
): Promise<BrowserDownloadResult> {
  const downloadPromise = page.waitForEvent('download', {
    timeout: DOWNLOAD_EVENT_TIMEOUT_MS,
  });
  void downloadPromise.catch(() => undefined);
  let clickCompleted = false;

  try {
    await locator.click();
    clickCompleted = true;
    return await readBrowserDownload(await downloadPromise, downloadReader);
  } catch (error) {
    if (!clickCompleted) {
      // Deliberately do not retain Playwright's error: a remote-driver error
      // may include its session-control URL. The caller already resolved one
      // exact node; a failed click is reported without unsafe metadata.
      void error;
      throw new Error(`${targetDescription} could not be clicked for download.`);
    }
    throw new Error(
      `${targetDescription} has no HTTP(S) href and did not start a browser download. ` +
        'Inspect the page again and choose a download link or control, or pass a verified direct URL.',
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

/** Reject a failed download before its reader is asked for bytes it cannot
 * have — the failure check is engine-level and identical for every provider,
 * so it stays here rather than being restated in each reader. */
async function readBrowserDownload(
  download: Download,
  reader: BrowserDownloadReader,
): Promise<BrowserDownloadResult> {
  const failure = await download.failure();
  if (failure !== null) {
    throw new Error(`Browser download failed: ${failure}`);
  }

  return reader.read(download);
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
