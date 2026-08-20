import { describe, expect, it } from 'vitest';

import { errorMessage, isAbortError } from '../src/errors.js';

describe('error helpers', () => {
  it('renders Error messages and arbitrary thrown values conventionally', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage('failed')).toBe('failed');
    expect(errorMessage(null)).toBe('null');
  });

  it('recognizes only Error instances with the conventional abort name', () => {
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';

    expect(isAbortError(aborted)).toBe(true);
    expect(isAbortError(new Error('failed'))).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
  });
});
