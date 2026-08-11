import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateRunId } from './runId.js';

// The tests control the clock (vitest fake timers patch Date globally) so
// that same-millisecond and distinct-millisecond behavior is deterministic.
afterEach(() => {
  vi.useRealTimers();
});

describe('generateRunId', () => {
  it('returns ids made only of letters, digits, and hyphens (filesystem-safe)', () => {
    const id = generateRunId();
    // Non-empty, and by construction free of path separators and spaces.
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('returns distinct ids for two calls in the same millisecond', () => {
    vi.useFakeTimers({ now: new Date('2026-08-10T12:00:00.000Z') });
    const first = generateRunId();
    const second = generateRunId(); // clock has not advanced
    expect(second).not.toBe(first);
  });

  it('sorts ids lexically in creation order across distinct timestamps', () => {
    vi.useFakeTimers({ now: new Date('2026-08-10T12:00:00.999Z') });
    const first = generateRunId();
    // One millisecond later, across the second boundary (999ms -> 000ms) —
    // the rollover most likely to break lexical ordering.
    vi.setSystemTime(new Date('2026-08-10T12:00:01.000Z'));
    const second = generateRunId();
    // A distant jump for good measure.
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    const third = generateRunId();

    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});
