import type { AssertionResult } from '../types.js';

/**
 * The standing exact-columns check (user ruling, 2026-08-11): a task that
 * names CSV columns means exactly those columns — matched case-insensitively
 * as a set, with any missing column, extra column, or duplicate a failure.
 * An extra column (e.g. a self-initiated 'rank') is not a superset of
 * success, it is a different shape.
 *
 * @param header - the parsed CSV's header cells
 * @param requiredColumns - the task's named columns, lowercase, in task order
 * @returns one assertion named
 *   `CSV has exactly the columns <a, b, c> (no more, no fewer)`, failing
 *   with missing/extra/duplicate detail
 */
export function exactColumnsAssertion(
  header: string[],
  requiredColumns: readonly string[],
): AssertionResult {
  const normalized = header.map((h) => h.trim().toLowerCase());

  const missing = requiredColumns.filter((c) => !normalized.includes(c));
  const extra = normalized.filter((h) => !requiredColumns.includes(h));
  // Guards duplicated required names too (e.g. "a,a,b"): same set, wrong
  // cardinality, missed by the missing/extra checks alone.
  const rightCardinality = normalized.length === requiredColumns.length;

  const passed = missing.length === 0 && extra.length === 0 && rightCardinality;
  const problems = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
    extra.length > 0 ? `extra: ${extra.join(', ')}` : null,
    missing.length === 0 && extra.length === 0 && !rightCardinality
      ? 'duplicate column name(s)'
      : null,
  ].filter((p): p is string => p !== null);

  return {
    name: exactColumnsAssertionName(requiredColumns),
    passed,
    detail: passed
      ? `header: ${header.join(', ')}`
      : `${problems.join('; ')} (header: ${header.join(', ')})`,
  };
}

/**
 * The name `exactColumnsAssertion` gives its result, exposed so a grader can
 * emit the same-named failure on branches where there is no header to check
 * (missing or unparseable CSV).
 *
 * @param requiredColumns - the task's named columns, lowercase, in task order
 * @returns the stable assertion name for those columns
 */
export function exactColumnsAssertionName(requiredColumns: readonly string[]): string {
  return `CSV has exactly the columns ${requiredColumns.join(', ')} (no more, no fewer)`;
}
