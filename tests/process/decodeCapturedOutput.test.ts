import { describe, expect, it } from 'vitest';

import { decodeCapturedOutput } from '../../src/process/decodeCapturedOutput.js';

describe('decodeCapturedOutput', () => {
  it('reassembles a multibyte character split across several chunks', () => {
    expect(
      decodeCapturedOutput([
        Buffer.from([0x61, 0xf0]),
        Buffer.from([0x9f]),
        Buffer.from([0x98, 0x80, 0x62]),
      ]),
    ).toBe('a😀b');
  });

  it('keeps a complete multibyte character at the exact retained boundary', () => {
    expect(decodeCapturedOutput([Buffer.from('prefix中')])).toBe('prefix中');
  });

  it.each([
    ['two-byte', [0xc2]],
    ['three-byte', [0xe2, 0x82]],
    ['four-byte', [0xf0, 0x9f, 0x98]],
  ])('drops an incomplete trailing %s sequence', (_name, trailingBytes) => {
    expect(decodeCapturedOutput([Buffer.from('complete'), Buffer.from(trailingBytes)])).toBe(
      'complete',
    );
  });

  it('uses normal UTF-8 replacement semantics for invalid retained bytes', () => {
    expect(decodeCapturedOutput([Buffer.from([0x61, 0x80, 0xff, 0x62])])).toBe('a��b');
  });

  it('returns an empty string when no bytes were retained', () => {
    expect(decodeCapturedOutput([])).toBe('');
  });
});
