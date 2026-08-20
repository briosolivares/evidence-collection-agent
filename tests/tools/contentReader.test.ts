import { describe, expect, it } from 'vitest';

import { detectContentFormat } from '../../src/tools/contentReader.js';

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
