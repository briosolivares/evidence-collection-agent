// Shared helpers for the eval-harness test suites. Test-only: nothing under
// evals/ ships this module.
import type { AssertionResult } from './types.js';

/** Look up one grader assertion by its public name, failing loudly when absent. */
export function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (found === undefined) throw new Error(`no assertion named "${name}"`);
  return found;
}

/** Render a header + rows as CSV text with a trailing newline. */
export function csvText(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
}

/** A promise with its resolver exposed, for gating async test choreography. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
