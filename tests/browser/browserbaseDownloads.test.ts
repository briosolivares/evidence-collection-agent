import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Download } from 'playwright';

import {
  BROWSERBASE_API_BASE_URL,
  createBrowserbaseDownloadReader,
  selectRecord,
  verifyDownloadIntegrity,
  type BrowserbaseDownloadRecord,
} from '../../src/browser/browserbaseDownloads.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A finite fake clock: `sleep` records the requested delay and advances the
 * same counter `now` reads, so the poll loop's arithmetic can be pinned
 * without a real timer ever running. */
function makeClock(startMs = 0) {
  let time = startMs;
  const sleepCalls: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      time += ms;
    },
    sleepCalls,
  };
}

/** Just enough of a Playwright `Download` for the reader: the two methods it
 * actually calls. */
function fakeDownload(filename: string, url = 'https://example.test/download'): Download {
  return {
    suggestedFilename: () => filename,
    url: () => url,
  } as unknown as Download;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    arrayBuffer: async () => {
      throw new Error('a JSON response was read as bytes');
    },
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new Error('a byte response was read as JSON');
    },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

describe('verifyDownloadIntegrity', () => {
  const bytes = new TextEncoder().encode('evidence payload');

  it('passes on a matching SHA-256', () => {
    const record: BrowserbaseDownloadRecord = {
      id: '1',
      filename: 'a.csv',
      checksum: sha256Hex(bytes),
      size: bytes.byteLength,
    };
    expect(() => verifyDownloadIntegrity(record, bytes)).not.toThrow();
  });

  it('rejects a checksum mismatch', () => {
    const record: BrowserbaseDownloadRecord = {
      id: '1',
      filename: 'a.csv',
      checksum: sha256Hex(new TextEncoder().encode('a different payload')),
    };
    expect(() => verifyDownloadIntegrity(record, bytes)).toThrow(/SHA-256/);
  });

  it('rejects a size mismatch', () => {
    const record: BrowserbaseDownloadRecord = {
      id: '1',
      filename: 'a.csv',
      checksum: sha256Hex(bytes),
      size: bytes.byteLength + 1,
    };
    expect(() => verifyDownloadIntegrity(record, bytes)).toThrow(/bytes but was reported/);
  });

  it('rejects a missing checksum — an unverifiable download must not be recorded as evidence', () => {
    const record: BrowserbaseDownloadRecord = { id: '1', filename: 'a.csv' };
    expect(() => verifyDownloadIntegrity(record, bytes)).toThrow(/no checksum/);
  });

  it('rejects an empty/whitespace checksum the same as a missing one', () => {
    const record: BrowserbaseDownloadRecord = { id: '1', filename: 'a.csv', checksum: '   ' };
    expect(() => verifyDownloadIntegrity(record, bytes)).toThrow(/no checksum/);
  });

  it('accepts a sha256:-prefixed checksum and an upper-case hex checksum', () => {
    const hex = sha256Hex(bytes);
    expect(() =>
      verifyDownloadIntegrity({ id: '1', filename: 'a.csv', checksum: `sha256:${hex}` }, bytes),
    ).not.toThrow();
    expect(() =>
      verifyDownloadIntegrity(
        { id: '1', filename: 'a.csv', checksum: hex.toUpperCase() },
        bytes,
      ),
    ).not.toThrow();
  });
});

describe('selectRecord', () => {
  it('prefers an exact filename match over a newer differently-named record', () => {
    const records: BrowserbaseDownloadRecord[] = [
      { id: 'newer', filename: 'other.csv', createdAt: '2026-01-01T00:00:10.000Z' },
      { id: 'exact', filename: 'report.csv', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(selectRecord(records, 'report.csv', new Set())?.id).toBe('exact');
  });

  it('falls back to the newest unconsumed record when nothing matches by filename', () => {
    const records: BrowserbaseDownloadRecord[] = [
      { id: 'old', filename: 'x.csv', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', filename: 'y.csv', createdAt: '2026-01-01T00:00:10.000Z' },
    ];
    expect(selectRecord(records, 'report.csv', new Set())?.id).toBe('new');
  });

  it('never returns an already-consumed record', () => {
    const records: BrowserbaseDownloadRecord[] = [
      { id: 'a', filename: 'report.csv', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(selectRecord(records, 'report.csv', new Set(['a']))).toBeUndefined();
  });

  it('returns undefined when everything is consumed', () => {
    const records: BrowserbaseDownloadRecord[] = [
      { id: 'a', filename: 'x.csv', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', filename: 'y.csv', createdAt: '2026-01-01T00:00:01.000Z' },
    ];
    expect(selectRecord(records, 'report.csv', new Set(['a', 'b']))).toBeUndefined();
  });

  it('treats an unparseable createdAt as oldest', () => {
    const records: BrowserbaseDownloadRecord[] = [
      { id: 'bad-date', filename: 'x.csv', createdAt: 'not-a-real-date' },
      { id: 'good-date', filename: 'y.csv', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    // Neither matches by filename, so this exercises the newest-first
    // fallback: the unparseable timestamp must not win by sorting to the top.
    expect(selectRecord(records, 'report.csv', new Set())?.id).toBe('good-date');
  });
});

describe('createBrowserbaseDownloadReader', () => {
  it('polls until the record appears, fetches its bytes, and returns the BROWSER filename', async () => {
    const bytes = new TextEncoder().encode('csv,data\n1,2\n');
    const record: BrowserbaseDownloadRecord = {
      id: 'dl-1',
      // The remote store renamed the file; the browser's own suggestion must
      // win over this, per the module's documented correlation contract.
      filename: 'report(1).csv',
      checksum: sha256Hex(bytes),
      size: bytes.byteLength,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    let listCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) {
        listCalls += 1;
        return jsonResponse({ downloads: listCalls >= 3 ? [record] : [] });
      }
      if (url === `${BROWSERBASE_API_BASE_URL}/v1/downloads/dl-1`) {
        return bytesResponse(bytes);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'secret-key',
      sessionId: 'sess-1',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    const result = await reader.read(fakeDownload('report.csv'));

    expect(result.suggestedFilename).toBe('report.csv');
    expect(new TextDecoder().decode(result.bytes)).toBe('csv,data\n1,2\n');
    expect(listCalls).toBe(3);
    // Two polls found nothing before the third succeeded.
    expect(clock.sleepCalls).toEqual([1_000, 1_000]);
  });

  it('sends the API key only in the x-bb-api-key header, never in a URL', async () => {
    const bytes = new TextEncoder().encode('x');
    const record: BrowserbaseDownloadRecord = {
      id: 'dl-1',
      filename: 'f.csv',
      checksum: sha256Hex(bytes),
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toContain('super-secret-key');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-bb-api-key']).toBe('super-secret-key');
      if (url.includes('/v1/downloads?')) return jsonResponse({ downloads: [record] });
      return bytesResponse(bytes);
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'super-secret-key',
      sessionId: 'sess-1',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    await reader.read(fakeDownload('f.csv'));
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('resolves two same-named downloads in one session to two different records', async () => {
    const bytesA = new TextEncoder().encode('first');
    const bytesB = new TextEncoder().encode('second');
    const recordA: BrowserbaseDownloadRecord = {
      id: 'a',
      filename: 'report.csv',
      checksum: sha256Hex(bytesA),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const recordB: BrowserbaseDownloadRecord = {
      id: 'b',
      filename: 'report.csv',
      checksum: sha256Hex(bytesB),
      createdAt: '2026-01-01T00:00:01.000Z',
    };

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) return jsonResponse({ downloads: [recordA, recordB] });
      if (url.endsWith('/v1/downloads/a')) return bytesResponse(bytesA);
      if (url.endsWith('/v1/downloads/b')) return bytesResponse(bytesB);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'k',
      sessionId: 's',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Both records match by filename and neither is consumed yet, so the
    // first read takes the newest (b); the second read must not reuse it.
    const first = await reader.read(fakeDownload('report.csv'));
    const second = await reader.read(fakeDownload('report.csv'));

    expect(new TextDecoder().decode(first.bytes)).toBe('second');
    expect(new TextDecoder().decode(second.bytes)).toBe('first');
    expect([...reader.retrievedIds()].sort()).toEqual(['a', 'b']);
  });

  it('reports retrievedIds() as exactly the ids whose bytes were returned', async () => {
    const bytes = new TextEncoder().encode('only-one');
    const record: BrowserbaseDownloadRecord = {
      id: 'only',
      filename: 'f.csv',
      checksum: sha256Hex(bytes),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) return jsonResponse({ downloads: [record] });
      return bytesResponse(bytes);
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'k',
      sessionId: 's',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(reader.retrievedIds()).toEqual([]);
    await reader.read(fakeDownload('f.csv'));
    expect(reader.retrievedIds()).toEqual(['only']);
  });

  it('throws a clear error when nothing appears before the deadline, with bounded polling', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) return jsonResponse({ downloads: [] });
      throw new Error('should never fetch a download body when nothing was ever listed');
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'k',
      sessionId: 's',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(reader.read(fakeDownload('never.csv'))).rejects.toThrow(
      /never reported a download named "never\.csv"/,
    );
    // The deadline is 20s out at 1s poll intervals: exactly 20 sleeps, and
    // the clock must have reached (not merely approached) the deadline.
    expect(clock.sleepCalls).toHaveLength(20);
    expect(clock.sleepCalls.every((ms) => ms === 1_000)).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(21);
  });

  it('retries a non-2xx list response per the retry policy, then surfaces the error', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) return jsonResponse({}, { status: 500 });
      throw new Error('should never reach the per-file endpoint');
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'k',
      sessionId: 's',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(reader.read(fakeDownload('x.csv'))).rejects.toThrow(/500/);
    // Default retry policy is 4 attempts total for one listRecords() call;
    // the poll loop never gets a second iteration because listRecords()
    // itself throws once its own retries are exhausted.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('retries a non-2xx download-fetch response per the retry policy, then surfaces the error', async () => {
    const record: BrowserbaseDownloadRecord = {
      id: 'dl-1',
      filename: 'x.csv',
      checksum: 'irrelevant-fetch-never-succeeds',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/downloads?')) return jsonResponse({ downloads: [record] });
      return jsonResponse({}, { status: 503 });
    });

    const clock = makeClock();
    const reader = createBrowserbaseDownloadReader({
      apiKey: 'k',
      sessionId: 's',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(reader.read(fakeDownload('x.csv'))).rejects.toThrow(/503/);
  });
});
