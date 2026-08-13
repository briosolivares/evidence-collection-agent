import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OutputContract } from '../contracts/outputContract.js';
import type { OutputTableStore } from '../outputs/outputTable.js';
import {
  ARTIFACTS_DIR,
  MANIFEST_FILENAME,
  setArtifactCompletionStatus,
  type Manifest,
} from '../run/artifacts.js';
import { runCompletionCheck } from './completionCheck.js';

// Finalizing a run that ended without verification. The run is preserved —
// artifacts stay exactly where they are, hashes untouched — but the manifest
// must stop implying that every deliverable is trustworthy.
//
// The distinction that matters: `partial` is applied per output, derived from
// the code checks, not blanket-applied to the whole run. A screenshot the
// contract asked for and the run actually captured is complete and should
// still read as complete; the CSV that is missing half its rows is the one
// that must say partial. Marking everything partial would throw away exactly
// the information a grader or human needs.

/** What incomplete finalization did, for the harness's diagnostics. */
export interface IncompleteFinalization {
  /** Contract output ids whose requirements the code checks found unmet. */
  unsatisfiedOutputIds: string[];
  /** Run-dir-relative paths marked `partial`. */
  markedPartial: string[];
  /** Published paths left `complete` because their requirement was met. */
  leftComplete: string[];
}

/**
 * Mark the manifest truthfully for a run ending without verification.
 *
 * @param runDir - the run directory; its manifest must be initialized
 * @param contract - the run's contract, when it had one. Without a contract
 *   there is no requirement to compare against, so nothing is marked and
 *   the run is preserved untouched
 * @param tables - the run's typed-row store, when it had one. Passed through
 *   so the check RENDERS the table outputs: an unverified run that built
 *   valid rows must still preserve the deliverable those rows describe, and
 *   the marking below is what then labels it partial or complete. Without
 *   this, such a run preserves no table file at all
 * @returns what was marked (see IncompleteFinalization). Best-effort by
 *   design: a marking failure must never prevent a run from being preserved,
 *   so an entry that cannot be updated is skipped rather than thrown
 */
export function finalizeIncompleteRun(
  runDir: string,
  contract?: OutputContract,
  tables?: OutputTableStore,
): IncompleteFinalization {
  const result: IncompleteFinalization = {
    unsatisfiedOutputIds: [],
    markedPartial: [],
    leftComplete: [],
  };
  if (contract === undefined) return result;

  const check = runCompletionCheck(runDir, contract, tables);
  const unsatisfied = new Set(
    check.failures
      .map((failure) => failure.outputId)
      .filter((id): id is string => id !== undefined),
  );
  result.unsatisfiedOutputIds = [...unsatisfied];

  // Map each contract output to the published filename it claims, so only
  // the files behind an unmet requirement are downgraded.
  const filenameByOutputId = new Map<string, string>();
  for (const output of contract.outputs) {
    if (output.kind === 'table' || output.kind === 'document') {
      filenameByOutputId.set(output.id, `${ARTIFACTS_DIR}/${output.filename}`);
    }
  }

  const published = publishedPaths(runDir);
  for (const [outputId, relPath] of filenameByOutputId) {
    if (!published.has(relPath)) continue; // never written; nothing to mark
    const status = unsatisfied.has(outputId) ? 'partial' : 'complete';
    try {
      setArtifactCompletionStatus(runDir, relPath, status);
      (status === 'partial' ? result.markedPartial : result.leftComplete).push(relPath);
    } catch {
      // Preserving the run outranks perfect bookkeeping.
    }
  }

  // Captures (screenshots, downloads) have no single filename in the
  // contract. When their count requirement is unmet, every published capture
  // not already claimed by another output is partial evidence of an
  // unfinished set; when it is met, they stay complete.
  const captureOutputsUnsatisfied = contract.outputs.some(
    (output) =>
      (output.kind === 'screenshots' || output.kind === 'download') && unsatisfied.has(output.id),
  );
  if (captureOutputsUnsatisfied) {
    const claimed = new Set(filenameByOutputId.values());
    for (const relPath of published) {
      if (claimed.has(relPath)) continue;
      try {
        setArtifactCompletionStatus(runDir, relPath, 'partial');
        result.markedPartial.push(relPath);
      } catch {
        // As above.
      }
    }
  }

  return result;
}

/** Published (artifacts/) paths on record, or an empty set when the
 * manifest cannot be read. */
function publishedPaths(runDir: string): Set<string> {
  try {
    const manifestPath = join(runDir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return new Set();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    return new Set(
      (manifest.artifacts ?? [])
        .filter((entry) => entry.roles !== undefined)
        .map((entry) => entry.filename),
    );
  } catch {
    return new Set();
  }
}
