import { describe, expect, it } from 'vitest';

import {
  assertContentRange,
  createContentReaderRegistry,
  detectContentFormat,
  throwIfAborted,
  UnsupportedContentError,
  type ContentObservation,
  type ContentReader,
} from './contentReader.js';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const raw = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('detectContentFormat — bytes beat extensions', () => {
  it('reads a PDF by magic number even when the filename says .csv', () => {
    // The whole point of byte detection: an extension is mistake- and
    // attacker-controlled, a magic number is what the file actually is.
    expect(
      detectContentFormat({
        bytes: bytes('%PDF-1.7\nstuff'),
        filename: 'roster.csv',
        mediaType: 'text/csv',
      }),
    ).toBe('pdf');
  });

  it('reads HTML as HTML even when the filename and media type say .pdf', () => {
    expect(
      detectContentFormat({
        bytes: bytes('<!doctype html><html><body>hi</body></html>'),
        filename: 'report.pdf',
        mediaType: 'application/pdf',
      }),
    ).toBe('html');
  });

  it('detects JSON and HTML structurally, over a mislabelling server', () => {
    expect(detectContentFormat({ bytes: bytes('  {"a":1}'), mediaType: 'text/html' })).toBe('json');
    expect(detectContentFormat({ bytes: bytes('[1,2,3]'), mediaType: 'text/plain' })).toBe('json');
    expect(
      detectContentFormat({ bytes: bytes('<html>x</html>'), mediaType: 'application/json' }),
    ).toBe('html');
  });

  it('treats a ZIP as a spreadsheet only when it carries a spreadsheet part', () => {
    // XLSX: ZIP header plus an xl/ entry.
    expect(detectContentFormat({ bytes: bytes('PK\u0003\u0004xl/workbook.xml') })).toBe(
      'spreadsheet',
    );
    // A .docx is also a ZIP and must NOT be read as a spreadsheet.
    expect(detectContentFormat({ bytes: bytes('PK\u0003\u0004word/document.xml') })).toBe('text');
  });

  it('detects a legacy OLE2 spreadsheet', () => {
    expect(detectContentFormat({ bytes: raw(0xd0, 0xcf, 0x11, 0xe0, 0, 0) })).toBe('spreadsheet');
  });

  it('detects every image signature it claims to', () => {
    expect(detectContentFormat({ bytes: raw(0x89, 0x50, 0x4e, 0x47, 0, 0) })).toBe('image');
    expect(detectContentFormat({ bytes: raw(0xff, 0xd8, 0xff, 0xe0) })).toBe('image');
    expect(detectContentFormat({ bytes: bytes('GIF89a...') })).toBe('image');
    expect(detectContentFormat({ bytes: bytes('BM......') })).toBe('image');
    expect(detectContentFormat({ bytes: bytes('RIFF....WEBPVP8 ') })).toBe('image');
  });

  it('falls back to CSV on consistent delimited lines, then to text', () => {
    expect(detectContentFormat({ bytes: bytes('a,b,c\n1,2,3\n') })).toBe('csv');
    expect(detectContentFormat({ bytes: bytes('a\tb\n1\t2\n') })).toBe('csv');
    // One field per line is prose, not a table.
    expect(detectContentFormat({ bytes: bytes('just a sentence\nand another\n') })).toBe('text');
    // Inconsistent field counts are not a table either.
    expect(detectContentFormat({ bytes: bytes('a,b,c\n1,2\n') })).toBe('text');
  });

  it('honours a csv media type and, last, a .csv filename', () => {
    expect(detectContentFormat({ bytes: bytes('one\n'), mediaType: 'text/csv' })).toBe('csv');
    expect(detectContentFormat({ bytes: bytes('one\n'), filename: 'data.CSV' })).toBe('csv');
  });

  it('does not crash on empty or tiny input', () => {
    expect(detectContentFormat({ bytes: new Uint8Array() })).toBe('text');
    expect(detectContentFormat({ bytes: raw(0x25) })).toBe('text');
  });
});

describe('assertContentRange', () => {
  it('accepts a valid 1-based inclusive range', () => {
    expect(() => assertContentRange({ from: 1, to: 1 })).not.toThrow();
    expect(() => assertContentRange({ from: 2, to: 10 })).not.toThrow();
  });

  it.each([
    ['zero from', { from: 0, to: 5 }],
    ['negative from', { from: -1, to: 5 }],
    ['fractional to', { from: 1, to: 2.5 }],
    ['NaN', { from: Number.NaN, to: 5 }],
    ['Infinity', { from: 1, to: Infinity }],
    ['reversed', { from: 5, to: 2 }],
  ])('rejects %s', (_label, range) => {
    expect(() => assertContentRange(range)).toThrow();
  });
});

describe('createContentReaderRegistry', () => {
  const stub = (name: string, formats: ContentReader['formats']): ContentReader => ({
    name,
    formats,
    read: async (request): Promise<ContentObservation> => ({
      format: formats[0]!,
      text: `${name} read ${request.bytes.length} bytes`,
      locator: 'stub',
    }),
  });

  it('routes to the adapter for the detected format', async () => {
    const registry = createContentReaderRegistry([stub('pdf-stub', ['pdf'])]);
    const observation = await registry.read({ bytes: bytes('%PDF-1.7 body') });
    expect(observation.text).toContain('pdf-stub read');
  });

  it('throws UnsupportedContentError when nothing handles the format', async () => {
    const registry = createContentReaderRegistry([stub('pdf-stub', ['pdf'])]);
    await expect(registry.read({ bytes: bytes('{"a":1}') })).rejects.toBeInstanceOf(
      UnsupportedContentError,
    );
  });

  it('validates the range before dispatching', async () => {
    const registry = createContentReaderRegistry([stub('pdf-stub', ['pdf'])]);
    await expect(
      registry.read({ bytes: bytes('%PDF-1.7'), range: { from: 0, to: 3 } }),
    ).rejects.toThrow(/range\.from/);
  });

  it('lets a later adapter override an earlier one for the same format', () => {
    const registry = createContentReaderRegistry([stub('first', ['pdf']), stub('second', ['pdf'])]);
    expect(registry.readerFor('pdf')?.name).toBe('second');
  });
});

describe('throwIfAborted', () => {
  it('does nothing without a signal or before abort', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('throws an AbortError once aborted, so a long parse can stop between chunks', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});
