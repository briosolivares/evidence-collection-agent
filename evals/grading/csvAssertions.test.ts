import { describe, expect, it } from 'vitest';

import { exactColumnsAssertion, exactColumnsAssertionName } from './csvAssertions.js';

const REQUIRED = ['alpha', 'beta', 'gamma'] as const;

describe('exactColumnsAssertion', () => {
  it('passes on exactly the required columns, case-insensitively and ignoring padding', () => {
    const result = exactColumnsAssertion([' Alpha', 'BETA ', 'gamma'], REQUIRED);
    expect(result.passed).toBe(true);
    expect(result.name).toBe(exactColumnsAssertionName(REQUIRED));
  });

  it('fails on a missing column, naming it', () => {
    const result = exactColumnsAssertion(['alpha', 'beta'], REQUIRED);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/missing: gamma/);
  });

  it('fails on an extra column, naming it', () => {
    const result = exactColumnsAssertion(['alpha', 'beta', 'gamma', 'rank'], REQUIRED);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/extra: rank/);
  });

  it('fails on a duplicated required column (same set, wrong cardinality)', () => {
    const result = exactColumnsAssertion(['alpha', 'alpha', 'beta', 'gamma'], REQUIRED);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/duplicate/);
  });

  it('reports both missing and extra in one detail', () => {
    const result = exactColumnsAssertion(['alpha', 'beta', 'delta'], REQUIRED);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/missing: gamma/);
    expect(result.detail).toMatch(/extra: delta/);
  });
});
