import { randomBytes } from 'node:crypto';

/** Bytes of randomness in the id's suffix (12 hex chars — enough that
 * same-millisecond collisions are vanishingly unlikely). */
const RANDOM_SUFFIX_BYTES = 6;

/**
 * Generate the identifier for a new run, used to name its run directory.
 *
 * @returns a non-empty id containing only ASCII letters, digits, and
 *   hyphens — safe as a file or directory name on any platform (no path
 *   separators, no spaces). Ids generated in different milliseconds sort
 *   lexically in order of creation time, and every call returns a distinct
 *   id, even within the same millisecond.
 */
export function generateRunId(): string {
  // toISOString is fixed-width and zero-padded (e.g. 2026-08-10T12:00:00.999Z),
  // so replacing the filesystem-unsafe ':' and '.' with '-' keeps ids
  // lexically ordered by creation time.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(RANDOM_SUFFIX_BYTES).toString('hex');
  return `${timestamp}-${suffix}`;
}
