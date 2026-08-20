import { describe, expect, it } from 'vitest';

import {
  formatCompletionLine,
  formatDuration,
  formatTokens,
  truncate,
  windowAround,
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

describe('formatCompletionLine', () => {
  it('formats verified and incomplete terminal states', () => {
    expect(formatCompletionLine('complete', 42_000, 18_700)).toBe('Brewed in 42s · 18.7k tokens');
    expect(formatCompletionLine('incomplete', 84_000, 900)).toBe(
      'Incomplete after 1m 24s · 900 tokens',
    );
  });
});

describe('windowAround', () => {
  it('centers when possible and clamps at both ends', () => {
    const items = [0, 1, 2, 3, 4, 5];
    expect(windowAround(items, 0, 3)).toEqual({ start: 0, items: [0, 1, 2] });
    expect(windowAround(items, 3, 3)).toEqual({ start: 2, items: [2, 3, 4] });
    expect(windowAround(items, 5, 3)).toEqual({ start: 3, items: [3, 4, 5] });
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
