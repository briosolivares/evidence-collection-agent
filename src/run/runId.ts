import { randomBytes } from 'node:crypto';

/** Bytes of randomness in the id's suffix (6 hex chars — enough that
 * same-second collisions are vanishingly unlikely, and createRunDir fails
 * fast on the day one happens). */
const RANDOM_SUFFIX_BYTES = 3;

/** Longest slug kept from the label — enough to recognize the task at a
 * glance without the id turning back into an unreadable wall. */
const MAX_SLUG_LENGTH = 40;

/**
 * Generate the identifier for a new run, used to name its run directory:
 * `<date>_<time>_<label-slug>_<suffix>`, e.g.
 * `2026-08-10_08-00-53pm_top-5-hacker-news_9f3a2b` — readable at a glance
 * in a directory listing (the slug part is omitted when no label is given).
 * The timestamp is **local time on a 12-hour clock**, matching the clock
 * the person browsing the directory lives by; the manifest's `startedAt`
 * keeps the exact UTC instant.
 *
 * @param label - optional free text naming the run (typically the task
 *   text); it is slugified — lowercased, runs of other characters become
 *   single hyphens, truncated to a recognizable prefix — so any string is
 *   safe to pass
 * @returns a non-empty id containing only ASCII letters, digits, hyphens,
 *   and underscores — safe as a file or directory name on any platform (no
 *   path separators, no spaces). Ids sort lexically by date, so listings
 *   group by day in order; within a day the 12-hour clock means alphabetical
 *   order is not strictly clock order. Every call returns a distinct id,
 *   even within the same millisecond.
 */
export function generateRunId(label?: string): string {
  // Fixed-width, zero-padded local date/time; seconds precision reads best,
  // and uniqueness comes from the random suffix.
  const { date, time } = formatLocalTimestamp(new Date());
  const slug = label === undefined ? '' : slugify(label);
  const suffix = randomBytes(RANDOM_SUFFIX_BYTES).toString('hex');
  return [date, time, ...(slug === '' ? [] : [slug]), suffix].join('_');
}

/** Format an instant as zero-padded local `YYYY-MM-DD` and 12-hour-clock
 * `HH-MM-SS(am|pm)` (midnight hour renders as 12am, noon as 12pm). */
export function formatLocalTimestamp(instant: Date): { date: string; time: string } {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hours24 = instant.getHours();
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return {
    date: `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`,
    time: `${pad(hours12)}-${pad(instant.getMinutes())}-${pad(instant.getSeconds())}${meridiem}`,
  };
}

/** Reduce free text to a filesystem-safe lowercase hyphenated slug,
 * truncating on a word boundary where one falls inside the length cap. */
function slugify(label: string): string {
  const full = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= MAX_SLUG_LENGTH) return full;

  // Look one past the cap: a hyphen right at the boundary keeps its word.
  const cut = full.slice(0, MAX_SLUG_LENGTH + 1);
  const lastHyphen = cut.lastIndexOf('-');
  const truncated = lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut.slice(0, MAX_SLUG_LENGTH);
  return truncated.replace(/-+$/, '');
}
