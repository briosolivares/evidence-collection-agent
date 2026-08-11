import { describe, expect, it } from 'vitest';

import {
  CONTRIBUTOR_WINDOW_SIZE,
  parseContributorsResponse,
  parseUserName,
} from './githubClient.js';

describe('parseContributorsResponse', () => {
  it('sorts by contributions descending and keeps login + count', () => {
    const contributors = parseContributorsResponse([
      { login: 'small', contributions: 3 },
      { login: 'big', contributions: 900 },
      { login: 'mid', contributions: 40 },
    ]);
    expect(contributors.map((c) => c.login)).toEqual(['big', 'mid', 'small']);
    expect(contributors[0]!.contributions).toBe(900);
  });

  it('caps the window at CONTRIBUTOR_WINDOW_SIZE', () => {
    const many = Array.from({ length: CONTRIBUTOR_WINDOW_SIZE + 5 }, (_, i) => ({
      login: `dev-${i}`,
      contributions: 1000 - i,
    }));
    expect(parseContributorsResponse(many)).toHaveLength(CONTRIBUTOR_WINDOW_SIZE);
  });

  it('throws on a non-array response', () => {
    expect(() => parseContributorsResponse({ message: 'rate limited' })).toThrow(/array/);
  });

  it('throws on an entry missing login', () => {
    expect(() => parseContributorsResponse([{ contributions: 5 }])).toThrow(/login/);
  });
});

describe('parseUserName', () => {
  it('returns the trimmed public name', () => {
    expect(parseUserName({ name: '  Ada Lovelace ' })).toBe('Ada Lovelace');
  });

  it('returns null for a null, absent, or blank name', () => {
    expect(parseUserName({ name: null })).toBeNull();
    expect(parseUserName({})).toBeNull();
    expect(parseUserName({ name: '   ' })).toBeNull();
  });
});
