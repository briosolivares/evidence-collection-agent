import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatLocalTimestamp, generateRunId } from './runId.js';

// The tests control the clock (vitest fake timers patch Date globally) so
// that same-millisecond and distinct-millisecond behavior is deterministic.
afterEach(() => {
  vi.useRealTimers();
});

describe('generateRunId', () => {
  it('returns ids made only of letters, digits, hyphens, and underscores (filesystem-safe)', () => {
    const id = generateRunId();
    // Non-empty, and by construction free of path separators and spaces.
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('embeds a readable slug of the label between timestamp and suffix', () => {
    const instant = new Date('2026-08-11T03:00:53.211Z');
    vi.useFakeTimers({ now: instant });
    const id = generateRunId('Top 5 Hacker News stories: title, URL & points');
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:am|pm)_top-5-hacker-news-stories-title-url_[0-9a-f]{6}$/,
    );
    // The timestamp is the machine's local wall-clock reading of the
    // instant, not UTC — a run started at 8pm should not be named tomorrow.
    const { date, time } = formatLocalTimestamp(instant);
    expect(id.startsWith(`${date}_${time}_`)).toBe(true);
  });

  it('renders the hour on a 12-hour clock with an am/pm marker', () => {
    // Local-time constructor args make these expectations timezone-proof.
    expect(formatLocalTimestamp(new Date(2026, 7, 10, 0, 5, 9)).time).toBe('12-05-09am');
    expect(formatLocalTimestamp(new Date(2026, 7, 10, 9, 30, 1)).time).toBe('09-30-01am');
    expect(formatLocalTimestamp(new Date(2026, 7, 10, 12, 0, 0)).time).toBe('12-00-00pm');
    expect(formatLocalTimestamp(new Date(2026, 7, 10, 20, 0, 53)).time).toBe('08-00-53pm');
  });

  it('keeps any label filesystem-safe and the id a single path segment', () => {
    for (const label of ['../../etc/passwd', 'täsk / with % chaos!', '', '   ']) {
      const id = generateRunId(label);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('returns distinct ids for two calls in the same millisecond', () => {
    vi.useFakeTimers({ now: new Date('2026-08-10T12:00:00.000Z') });
    const first = generateRunId();
    const second = generateRunId(); // clock has not advanced
    expect(second).not.toBe(first);
  });

  it('sorts ids lexically across dates and within the same clock hour', () => {
    // The 12-hour clock gives up strict all-day lexical ordering (01pm
    // sorts before 12pm); what remains guaranteed is date-level grouping
    // and ordering within an hour — asserted here.
    vi.useFakeTimers({ now: new Date('2026-08-10T12:00:00.999Z') });
    const first = generateRunId();
    // One millisecond later, across the second boundary (999ms -> 000ms) —
    // the rollover most likely to break lexical ordering.
    vi.setSystemTime(new Date('2026-08-10T12:00:01.000Z'));
    const second = generateRunId();
    // A distant jump onto a later date.
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    const third = generateRunId();

    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});
