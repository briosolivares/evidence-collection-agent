/**
 * Download readers.
 *
 * Turning a Playwright `download` event into bytes is the one browser
 * operation whose mechanics differ between a local Chrome and a remote
 * browser service, so it is the one thing {@link PlaywrightBrowserController}
 * takes as a strategy rather than doing itself.
 *
 * Local Chrome writes the file where this process can read it, and
 * `Download.createReadStream()` hands it back directly. A Browserbase browser
 * writes it inside the remote container instead: the stream is unavailable
 * (or empty), and the bytes have to be fetched back out through Browserbase's
 * Downloads API — see `browserbaseDownloads.ts`.
 *
 * Everything downstream is unchanged either way: both readers return the same
 * {@link BrowserDownloadResult}, published through `publish_artifact`. The local run directory stays the evidence system of
 * record; a remote browser service is a transport, not provenance.
 */
import type { Download } from 'playwright';

import type { BrowserDownloadResult } from './controller.js';

/**
 * Reads the bytes of one completed browser download.
 *
 * @param download - the Playwright download event, already known to have
 *   completed without failure
 * @returns the download's bytes plus its final URL and suggested filename
 * @throws when the bytes cannot be retrieved within the reader's own bounded
 *   deadline, or (for remote readers) fail their integrity check
 */
export interface BrowserDownloadReader {
  read(download: Download): Promise<BrowserDownloadResult>;
}

/**
 * The local-Chrome reader: read the file Playwright already has on disk.
 *
 * This is the behavior every download took before a remote provider existed,
 * kept verbatim so a local session's download path is not affected by the
 * remote one existing.
 */
export const localDownloadReader: BrowserDownloadReader = {
  async read(download: Download): Promise<BrowserDownloadResult> {
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
      bytes: new Uint8Array(Buffer.concat(chunks)),
      suggestedFilename: download.suggestedFilename(),
    };
  },
};
