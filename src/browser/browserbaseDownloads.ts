/**
 * Browserbase download retrieval.
 *
 * A local Chrome writes a download where this process can read it. A
 * Browserbase browser writes it inside the remote container, so
 * `Download.createReadStream()` has nothing to hand back and the bytes must be
 * fetched out through Browserbase's Downloads API instead.
 *
 * Three things make that harder than one GET:
 *
 * 1. The API is eventually consistent — "files sync in real time, but large
 *    downloads may not be immediately available" — so the list is polled
 *    against a finite deadline rather than read once.
 * 2. Nothing in the download EVENT identifies the remote record. Correlation
 *    is by filename, with a newest-unconsumed fallback for the case where the
 *    remote store renamed the file (a second `report.csv` in one session), and
 *    a consumed-id set so two downloads of the same name in one session cannot
 *    both resolve to the first record.
 * 3. The bytes have crossed a network the run does not control, so the
 *    SHA-256 checksum Browserbase reports is verified before they are handed
 *    to the caller. Downloads are evidence; an unverified byte string that
 *    later fails a manifest hash is much more expensive to diagnose than a
 *    loud failure here.
 *
 * Deliberately plain `fetch` rather than the vendor SDK: the SDK's
 * `sessions.downloads.list` is the older whole-session-archive endpoint, while
 * the per-file endpoints used here (`GET /v1/downloads?sessionId=`,
 * `GET /v1/downloads/{id}`) return one file with its checksum. `fetch` is
 * injectable, which is also what keeps this module's tests hermetic.
 */
import { createHash } from 'node:crypto';

import type { Download } from 'playwright';

import type { BrowserDownloadResult } from './controller.js';
import type { BrowserDownloadReader } from './downloadReader.js';
import { withBrowserbaseRetry, type BrowserbaseRetryOptions } from './browserbaseRetry.js';

/** Default API origin; overridable for tests and for a self-hosted endpoint. */
export const BROWSERBASE_API_BASE_URL = 'https://api.browserbase.com';

/** How long to keep polling for a download record to appear. Browserbase's own
 * guidance is to persist up to ~20s for large files to sync. */
const DOWNLOAD_SYNC_DEADLINE_MS = 20_000;
/** Gap between list polls while the record has not appeared yet. */
const DOWNLOAD_SYNC_POLL_INTERVAL_MS = 1_000;
/** Page size for the session's download list. Far above any single run's
 * download count; a session that exceeds it has other problems. */
const DOWNLOAD_LIST_LIMIT = 100;

/** One remote download record as Browserbase reports it. */
export interface BrowserbaseDownloadRecord {
  id: string;
  filename: string;
  /** SHA-256 of the stored file, hex. */
  checksum?: string;
  size?: number;
  mimeType?: string;
  createdAt?: string;
}

export interface BrowserbaseDownloadReaderOptions {
  apiKey: string;
  sessionId: string;
  baseUrl?: string;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seams for the polling clock. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Receives retry/progress lines. Never receives the API key. */
  onWarning?: (message: string) => void;
}

/**
 * Build the download reader for one Browserbase session.
 *
 * @param options - the session's id, an API key (never logged), and the test
 *   seams for HTTP and the clock
 */
export function createBrowserbaseDownloadReader(
  options: BrowserbaseDownloadReaderOptions,
): BrowserDownloadReader {
  const baseUrl = options.baseUrl ?? BROWSERBASE_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const retryOptions: BrowserbaseRetryOptions = {
    sleep,
    ...(options.onWarning === undefined ? {} : { onRetry: options.onWarning }),
  };
  /** Remote records already handed to a caller. Two downloads of the same
   * filename in one session must resolve to two different records. */
  const consumed = new Set<string>();

  const request = async (path: string, accept: string): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { 'x-bb-api-key': options.apiKey, Accept: accept },
    });
    if (!response.ok) {
      // Carries `status`/`headers` so withBrowserbaseRetry can classify it and
      // honor Retry-After exactly as it does an SDK error. The path is safe to
      // name (no key, no connection URL); the key lives only in the header.
      throw Object.assign(
        new Error(`Browserbase download request failed: ${response.status} ${path}`),
        { status: response.status, headers: response.headers },
      );
    }
    return response;
  };

  const listRecords = async (): Promise<BrowserbaseDownloadRecord[]> => {
    const response = await withBrowserbaseRetry(
      'list downloads',
      () =>
        request(
          `/v1/downloads?sessionId=${encodeURIComponent(options.sessionId)}` +
            `&limit=${DOWNLOAD_LIST_LIMIT}`,
          'application/json',
        ),
      retryOptions,
    );
    const body = (await response.json()) as { downloads?: BrowserbaseDownloadRecord[] } | null;
    return body?.downloads ?? [];
  };

  return {
    async read(download: Download): Promise<BrowserDownloadResult> {
      const suggestedFilename = download.suggestedFilename();
      const record = await pollForRecord({
        suggestedFilename,
        consumed,
        listRecords,
        now,
        sleep,
      });
      consumed.add(record.id);

      const response = await withBrowserbaseRetry(
        'fetch download',
        () => request(`/v1/downloads/${encodeURIComponent(record.id)}`, 'application/octet-stream'),
        retryOptions,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      verifyDownloadIntegrity(record, bytes);

      return {
        finalUrl: download.url(),
        bytes,
        // The browser's own suggestion, not the remote store's: the filename
        // the page asked for is what the rest of the run (and the artifact
        // manifest) already reasons about, and the remote store may have
        // de-duplicated it.
        suggestedFilename,
      };
    },
  };
}

/**
 * Wait for a remote record matching this download to appear.
 *
 * @throws Error when no unconsumed record appears within the deadline — a
 *   remote download that never synced must fail loudly, since silently
 *   returning the wrong file's bytes would be recorded as evidence
 */
async function pollForRecord(deps: {
  suggestedFilename: string;
  consumed: ReadonlySet<string>;
  listRecords: () => Promise<BrowserbaseDownloadRecord[]>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<BrowserbaseDownloadRecord> {
  const deadline = deps.now() + DOWNLOAD_SYNC_DEADLINE_MS;
  for (;;) {
    const records = await deps.listRecords();
    const match = selectRecord(records, deps.suggestedFilename, deps.consumed);
    if (match !== undefined) return match;

    if (deps.now() >= deadline) {
      throw new Error(
        `Browserbase never reported a download named ${JSON.stringify(deps.suggestedFilename)} ` +
          `within ${DOWNLOAD_SYNC_DEADLINE_MS}ms of the browser starting it. The file did not ` +
          'sync out of the remote browser; nothing was written.',
      );
    }
    await deps.sleep(DOWNLOAD_SYNC_POLL_INTERVAL_MS);
  }
}

/**
 * Pick the record this download event refers to.
 *
 * Exact filename first, then the newest unconsumed record: the remote store
 * may rename a colliding filename, and a session's only outstanding download
 * is overwhelmingly the one that just fired. Consumed records are never
 * reused, so two same-named downloads in one session resolve separately.
 *
 * Exported for its own test — the ordering rules here are the whole
 * correlation contract.
 */
export function selectRecord(
  records: readonly BrowserbaseDownloadRecord[],
  suggestedFilename: string,
  consumed: ReadonlySet<string>,
): BrowserbaseDownloadRecord | undefined {
  const available = records.filter((record) => !consumed.has(record.id));
  const newestFirst = [...available].sort((left, right) => createdAtMs(right) - createdAtMs(left));
  return newestFirst.find((record) => record.filename === suggestedFilename) ?? newestFirst[0];
}

function createdAtMs(record: BrowserbaseDownloadRecord): number {
  const parsed = record.createdAt === undefined ? NaN : Date.parse(record.createdAt);
  // An unparseable timestamp sorts oldest rather than throwing: ordering is a
  // preference here, not a correctness requirement.
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Check retrieved bytes against what Browserbase says it stored.
 *
 * A missing checksum is a failure, not a pass. These bytes become evidence
 * under a local manifest hash, and "we could not verify it so we accepted it"
 * is precisely the outcome the manifest exists to rule out.
 *
 * Exported for its own test.
 *
 * @throws Error when the size or SHA-256 disagrees, or no checksum was
 *   reported at all
 */
export function verifyDownloadIntegrity(
  record: BrowserbaseDownloadRecord,
  bytes: Uint8Array,
): void {
  if (record.size !== undefined && record.size !== bytes.byteLength) {
    throw new Error(
      `Browserbase download ${record.filename} is ${bytes.byteLength} bytes but was reported ` +
        `as ${record.size}; the retrieved file is incomplete and was not written.`,
    );
  }

  const expected = record.checksum
    ?.trim()
    .replace(/^sha-?256[:=]/i, '')
    .toLowerCase();
  if (expected === undefined || expected === '') {
    throw new Error(
      `Browserbase reported no checksum for download ${record.filename}, so its bytes cannot ` +
        'be verified. Refusing to record an unverified download as evidence.',
    );
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Browserbase download ${record.filename} failed its SHA-256 check (expected ${expected}, ` +
        `got ${actual}); the retrieved bytes were discarded.`,
    );
  }
}
