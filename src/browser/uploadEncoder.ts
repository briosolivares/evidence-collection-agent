/**
 * Upload encoders.
 *
 * The mirror image of `downloadReader.ts`, and it exists for a failure that is
 * easy to miss: Playwright's `setInputFiles(path)` hands the browser a
 * FILESYSTEM PATH. Its client only converts a path into bytes when it believes
 * the browser is remote, and it decides that from whether its own driver is
 * remote — which, under `chromium.connectOverCDP`, it is not. The driver runs
 * in this process; only the browser is elsewhere. So Playwright happily sends
 * `DOM.setFileInputFiles` with `/Users/.../runs/<run>/scratch/workspace/x.csv`
 * to a Chrome inside a container that has no such path, and the upload fails or
 * attaches nothing.
 *
 * Encoding the file into a buffer payload instead is the fix, and it has to be
 * a per-provider choice rather than a blanket one: reading every upload into
 * memory is pointless work for a local Chrome that can simply open the file.
 *
 * The confinement guarantee is untouched either way. The v3 host validates a
 * no-follow regular file under `scratch/workspace` before the command session
 * calls an encoder, so this module sees only an already-confined absolute path.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/** A file's bytes plus the name and type the page should see. Structurally
 * Playwright's `FilePayload`; restated so this module carries no dependency on
 * a name from Playwright's generated types. */
export interface UploadPayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface BrowserUploadEncoder {
  /**
   * Prepare already-confined absolute paths for `setInputFiles`.
   *
   * Batched rather than per-file on purpose: Playwright rejects an array that
   * mixes paths and buffers, and encoding the whole set at once makes mixing
   * unrepresentable instead of merely avoided.
   *
   * @param absolutePaths - paths the v3 host has already confined to the run
   *   workspace
   * @returns the paths themselves, or the files' bytes when the browser cannot
   *   see this filesystem — never a mixture
   * @throws when a file cannot be read (remote encoder only)
   */
  encode(absolutePaths: readonly string[]): Promise<string[] | UploadPayload[]>;
}

/** Local Chrome shares this filesystem: hand it the paths and let it read. */
export const localUploadEncoder: BrowserUploadEncoder = {
  encode: async (absolutePaths: readonly string[]) => [...absolutePaths],
};

/** A remote browser cannot see this filesystem, so send the bytes. */
export const remoteUploadEncoder: BrowserUploadEncoder = {
  encode: (absolutePaths: readonly string[]) =>
    Promise.all(
      absolutePaths.map(async (absolutePath) => ({
        name: basename(absolutePath),
        mimeType: guessUploadMimeType(absolutePath),
        buffer: await readFile(absolutePath),
      })),
    ),
};

/**
 * Content types for the file kinds this agent actually produces and uploads.
 *
 * Deliberately a short table rather than a dependency. `setInputFiles` needs a
 * type string, and a local upload never had to supply one (Chrome sniffs the
 * file itself), so the only requirement is that the common cases are right and
 * everything else degrades to a type no page will reject outright.
 *
 * Exported for its own test.
 */
function guessUploadMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.html':
      return 'text/html';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}
