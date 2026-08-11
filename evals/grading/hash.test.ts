import { describe, expect, it } from 'vitest';

import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the known test vector for "abc"', () => {
    // https://en.wikipedia.org/wiki/SHA-2#Test_vectors
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and sensitive to a single byte change', () => {
    const a = sha256Hex(Buffer.from('evidence'));
    const b = sha256Hex(Buffer.from('evidence'));
    const c = sha256Hex(Buffer.from('Evidence'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
