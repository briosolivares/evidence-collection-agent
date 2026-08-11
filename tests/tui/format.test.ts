import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatTokens,
  shortenUrl,
  truncate,
} from '../../src/tui/format.js';

describe('formatTokens', () => {
  it('renders sub-thousand counts verbatim', () => {
    expect(formatTokens(847)).toBe('847 tokens');
    expect(formatTokens(0)).toBe('0 tokens');
    expect(formatTokens(999)).toBe('999 tokens');
  });

  it('switches to one-decimal k at 1000', () => {
    expect(formatTokens(1000)).toBe('1.0k tokens');
    expect(formatTokens(3200)).toBe('3.2k tokens');
    expect(formatTokens(18700)).toBe('18.7k tokens');
    expect(formatTokens(31200)).toBe('31.2k tokens');
  });
});

describe('formatDuration', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_400)).toBe('59s');
  });

  it('renders a minute and up as m s', () => {
    expect(formatDuration(84_000)).toBe('1m 24s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(725_000)).toBe('12m 5s');
  });

  it('rounds to whole seconds and clamps negatives to zero', () => {
    expect(formatDuration(41_700)).toBe('42s');
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('truncate', () => {
  it('passes short text through and caps long text with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij');
    expect(truncate('abcdefghijk', 10)).toBe('abcdefghi…');
    expect(truncate('abcdefghijk', 10)).toHaveLength(10);
  });
});

describe('shortenUrl', () => {
  it('drops protocol and www, keeping host and path', () => {
    expect(shortenUrl('https://www.sec.gov/cgi-bin/browse-edgar')).toBe(
      'sec.gov/cgi-bin/browse-edgar',
    );
  });

  it('renders a bare origin as just the host', () => {
    expect(shortenUrl('https://news.ycombinator.com/')).toBe('news.ycombinator.com');
    expect(shortenUrl('https://news.ycombinator.com')).toBe('news.ycombinator.com');
  });

  it('keeps the query string when present', () => {
    expect(shortenUrl('https://example.com/search?q=acme', 60)).toBe(
      'example.com/search?q=acme',
    );
  });

  it('truncates to the maximum length with an ellipsis', () => {
    const long = `https://www.sec.gov/${'x'.repeat(100)}`;
    const shortened = shortenUrl(long, 40);
    expect(shortened).toHaveLength(40);
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened.startsWith('sec.gov/')).toBe(true);
  });

  it('truncates non-URL text instead of throwing', () => {
    expect(shortenUrl('not a url', 40)).toBe('not a url');
    expect(shortenUrl('x'.repeat(50), 40)).toHaveLength(40);
  });
});
