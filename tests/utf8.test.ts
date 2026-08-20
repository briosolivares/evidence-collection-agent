import { describe, expect, it } from 'vitest';

import { decodeUtf8 } from '../src/utf8.js';

describe('decodeUtf8', () => {
  it('decodes valid text and preserves the decoder default of stripping a leading BOM', () => {
    expect(decodeUtf8(Buffer.from('hello', 'utf8'))).toBe('hello');
    expect(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
  });

  it('returns undefined for invalid byte sequences', () => {
    expect(decodeUtf8(Buffer.from([0x68, 0x69, 0xff]))).toBeUndefined();
  });
});
