import { describe, expect, it } from 'vitest';

import {
  detectResourceFormat,
  extractHtmlText,
  parseDelimitedText,
  parseResourceBody,
  MAX_HTML_LINKS,
} from './parseResource.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('detectResourceFormat', () => {
  it('trusts an explicit media type', () => {
    expect(detectResourceFormat('application/json; charset=utf-8', '{}')).toBe('json');
    expect(detectResourceFormat('application/vnd.api+json', '{}')).toBe('json');
    expect(detectResourceFormat('text/csv', 'a,b\n1,2')).toBe('csv');
    expect(detectResourceFormat('text/html; charset=utf-8', '<p>hi</p>')).toBe('html');
  });

  it('sniffs past a generic or wrong media type', () => {
    // Real endpoints serve JSON as text/plain often enough that the label
    // alone cannot decide.
    expect(detectResourceFormat('text/plain', '  {"a":1}')).toBe('json');
    expect(detectResourceFormat('application/octet-stream', '[1,2,3]')).toBe('json');
    expect(detectResourceFormat(undefined, '<!doctype html><title>x</title>')).toBe('html');
    expect(detectResourceFormat('text/plain', 'name,value\nalpha,1\nbeta,2')).toBe('csv');
    expect(detectResourceFormat('text/plain', 'just some prose about things')).toBe('text');
  });

  it('does not claim JSON for a body that only starts like one', () => {
    expect(detectResourceFormat('text/plain', '{"a": 1, "b": [')).toBe('text');
  });
});

describe('parseDelimitedText', () => {
  it('parses quoted fields, escaped quotes, embedded newlines, and CRLF', () => {
    const table = parseDelimitedText(
      'name,note\r\n"Doe, Jane","said ""hi""\nthen left"\r\nBob,plain\r\n',
    );
    expect(table).toBeDefined();
    expect(table?.columns).toEqual(['name', 'note']);
    expect(table?.rows).toEqual([
      ['Doe, Jane', 'said "hi"\nthen left'],
      ['Bob', 'plain'],
    ]);
    expect(table?.rowCount).toBe(2);
    expect(table?.delimiter).toBe(',');
  });

  it('detects tabs and semicolons', () => {
    expect(parseDelimitedText('a\tb\n1\t2')?.delimiter).toBe('\t');
    expect(parseDelimitedText('a;b\n1;2')?.delimiter).toBe(';');
  });

  it('synthesizes column names when the first row is data', () => {
    const table = parseDelimitedText('1,2,3\n4,5,6');
    expect(table?.columns).toEqual(['column1', 'column2', 'column3']);
    // No row is swallowed into a header.
    expect(table?.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('pads short rows and folds overflow into the last column', () => {
    const table = parseDelimitedText('a,b,c\n1,2\n3,4,5\n6,7,8\n9,10,11,12');
    expect(table?.rows).toEqual([
      ['1', '2', ''],
      ['3', '4', '5'],
      ['6', '7', '8'],
      ['9', '10', '11 12'],
    ]);
  });

  it('returns undefined for prose that is not tabular', () => {
    expect(parseDelimitedText('one line, with a comma')).toBeDefined();
    expect(parseDelimitedText('a sentence.\nanother sentence.')).toBeUndefined();
    expect(parseDelimitedText('')).toBeUndefined();
  });
});

describe('extractHtmlText', () => {
  it('drops script and style content, keeps block structure, and decodes entities', () => {
    const extracted = extractHtmlText(
      '<!doctype html><html><head><title>  Q3 &amp; Q4  </title>' +
        '<style>body{color:red}</style><script>var secret = "leak";</script></head>' +
        '<body><h1>Revenue</h1><table><tr><td>Q3</td><td>1,200</td></tr>' +
        '<tr><td>Q4</td><td>1,500</td></tr></table>' +
        '<p>Filed&nbsp;2026 &lt;final&gt;</p></body></html>',
    );

    expect(extracted.title).toBe('Q3 & Q4');
    expect(extracted.text).not.toContain('leak');
    expect(extracted.text).not.toContain('color:red');
    expect(extracted.text).toContain('Revenue');
    expect(extracted.text).toContain('Q3\t1,200');
    expect(extracted.text).toContain('Filed 2026 <final>');
  });

  it('returns absolute, deduplicated, http-only links', () => {
    const extracted = extractHtmlText(
      '<a href="/a.json">a</a><a href=\'/a.json\'>same</a>' +
        '<a href=data.csv>rel</a><a href="mailto:x@y.test">mail</a>' +
        '<a href="javascript:alert(1)">js</a><a href="https://other.test/x#frag">abs</a>',
      'https://example.test/dir/page.html',
    );

    expect(extracted.links).toEqual([
      'https://example.test/a.json',
      'https://example.test/dir/data.csv',
      'https://other.test/x',
    ]);
  });

  it('bounds the link list', () => {
    const html = Array.from(
      { length: MAX_HTML_LINKS + 20 },
      (_value, index) => `<a href="/p${index}">${index}</a>`,
    ).join('');
    expect(extractHtmlText(html, 'https://example.test/').links).toHaveLength(MAX_HTML_LINKS);
  });
});

describe('parseResourceBody', () => {
  it('returns parsed JSON plus a pretty rendering for the offload path', () => {
    const parsed = parseResourceBody(bytes('{"rows":[{"n":1}]}'), {
      contentType: 'application/json',
    });
    expect(parsed.format).toBe('json');
    expect(parsed.json).toEqual({ rows: [{ n: 1 }] });
    expect(parsed.rendered).toContain('"rows"');
    expect(parsed.rendered).toContain('\n');
  });

  it('falls back to text with a warning when a requested format does not fit', () => {
    const parsed = parseResourceBody(bytes('{"truncated": '), { format: 'json' });
    expect(parsed.format).toBe('text');
    expect(parsed.parseWarning).toContain('not valid JSON');
    expect(parsed.text).toBe('{"truncated": ');

    const prose = parseResourceBody(bytes('no delimiters here'), { format: 'csv' });
    expect(prose.format).toBe('text');
    expect(prose.parseWarning).toContain('no delimited rows');
  });

  it('renders a delimited body as its original text so the offload copy stays exact', () => {
    const csv = 'name,value\nalpha,1\nbeta,2\n';
    const parsed = parseResourceBody(bytes(csv), { contentType: 'text/csv' });
    expect(parsed.format).toBe('csv');
    expect(parsed.table?.rowCount).toBe(2);
    expect(parsed.rendered).toBe(csv);
  });

  it('decodes a declared non-UTF-8 charset', () => {
    // 0xe9 is 'é' in latin1 and invalid UTF-8; the declared charset decides.
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(
      parseResourceBody(latin1, { contentType: 'text/plain; charset=iso-8859-1' }).text,
    ).toBe('café');
    // An unknown label falls back to UTF-8 rather than failing the read.
    expect(
      parseResourceBody(bytes('plain'), { contentType: 'text/plain; charset=not-a-charset' }).text,
    ).toBe('plain');
  });
});
