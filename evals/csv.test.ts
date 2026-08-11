import { describe, expect, it } from 'vitest';

import { parseCsv, parseCsvRows } from './csv.js';

describe('parseCsvRows', () => {
  it('splits plain comma-delimited rows on newlines', () => {
    expect(parseCsvRows('title,url,points\nFoo,http://a,10\nBar,http://b,5')).toEqual([
      ['title', 'url', 'points'],
      ['Foo', 'http://a', '10'],
      ['Bar', 'http://b', '5'],
    ]);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('treats CRLF line endings the same as bare LF', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside a quoted field as part of the cell', () => {
    expect(parseCsvRows('title,points\n"Ask HN: foo, bar",42')).toEqual([
      ['title', 'points'],
      ['Ask HN: foo, bar', '42'],
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsvRows('title\n"She said ""hi"""')).toEqual([['title'], ['She said "hi"']]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsvRows('')).toEqual([]);
  });
});

describe('parseCsv', () => {
  it('splits the first row as header and the rest as data rows', () => {
    const parsed = parseCsv('title,url,points\nFoo,http://a,10\nBar,http://b,5\n');
    expect(parsed.header).toEqual(['title', 'url', 'points']);
    expect(parsed.rows).toEqual([
      ['Foo', 'http://a', '10'],
      ['Bar', 'http://b', '5'],
    ]);
  });

  it('throws on empty input', () => {
    expect(() => parseCsv('')).toThrow(/no rows|empty/);
  });

  it('returns an empty rows array for header-only input', () => {
    expect(parseCsv('title,url,points\n')).toEqual({
      header: ['title', 'url', 'points'],
      rows: [],
    });
  });
});
