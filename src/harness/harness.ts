import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRoleUsage } from '../run/runBudget.js';
import type { IncompleteRunReason } from '../run/runOutcome.js';

// Shared diagnostics helpers for runTask.ts's verification harness (see
// runVerificationHarness). Nothing here decides control flow — that lives
// in runTask.ts — this is the run-dir I/O for the harness's own
// diagnostics file. The old per-cycle metrics archival and rollup
// (archiveCycleMetrics/rollupCycleMetrics/writeMetricsRollup) are gone
// with the fresh-loop-per-cycle model itself: one persistent WorkerSession
// spans every correction cycle, and its single metrics.json carries the
// whole run's aggregates plus per-role usage (see
// workerSession.writeWorkerSessionMetrics and RunRoleMetrics).

/** Name of the harness diagnostics file at the run-dir root. Written once,
 * at the end of the cycle loop, in harness-mode runs only — judge-less runs
 * (no `config.harness`) never produce this file. */
export const HARNESS_FILENAME = 'harness.json';

/** Per-role usage as recorded in metrics.json's `roles` map — the shape
 * the shared RunBudgetTracker accumulates (see runBudget.ts). */
export type RunRoleMetrics = RunRoleUsage;

/**
 * One worker cycle's outcome, as recorded for harness.json diagnostics.
 * `verdict` and `reason` are both absent when the judge never ran for this
 * cycle (a `budget_exceeded` worker result skips the judge outright —
 * budgets end runs). `reason` is also absent on a `done` verdict, whose
 * JudgeVerdict.reason is always the empty string — nothing worth recording.
 */
export interface HarnessCycleRecord {
  /** 1-based cycle index. */
  cycle: number;
  /** This cycle's worker outcome ('completed' or 'budget_exceeded'). */
  workerStatus: string;
  /** The judge's verdict, when the judge ran this cycle. */
  verdict?: 'done' | 'continue';
  /** The judge's reason, when non-empty. */
  reason?: string;
  /** The error message when the judge itself crashed this cycle (an
   * infrastructure failure, never a verdict). The run ends incomplete with
   * reason `verifier_unavailable`; this field is the diagnostic trail.
   * Mutually exclusive with `verdict`/`reason`. */
  judgeError?: string;
}

/** The harness's own record of how the run ended — mirrors the returned
 * RunOutcome so the run directory is self-describing. */
export type HarnessOutcomeRecord =
  | { status: 'verified' }
  | { status: 'incomplete'; reason: IncompleteRunReason; detail: string };

/** Harness-mode run diagnostics: the initializer's model, one record per
 * worker cycle, and the truthful terminal outcome. Written by
 * writeHarnessDiagnostics; nothing else reads or writes harness.json. */
export interface HarnessDiagnostics {
  /** Which model produced this run's contract-authoring phase. Documents
   * which role wrote the contract, not which function object answered. */
  initializer: { model: string };
  /** One entry per worker cycle that ran, in cycle order. */
  cycles: HarnessCycleRecord[];
  /** How the run ended. Judge crash, correction exhaustion, and budget
   * exhaustion are all explicit incomplete reasons here — none of them can
   * be recorded as success. */
  outcome: HarnessOutcomeRecord;
}

/**
 * Write the harness's diagnostics file at the run-dir root.
 *
 * @param runDir - absolute path to the run directory
 * @param diagnostics - the complete diagnostics for this run
 * @returns nothing; overwrites `<runDir>/harness.json` with the
 *   pretty-printed diagnostics plus a trailing newline
 */
export function writeHarnessDiagnostics(runDir: string, diagnostics: HarnessDiagnostics): void {
  writeFileSync(
    join(runDir, HARNESS_FILENAME),
    `${JSON.stringify(diagnostics, null, 2)}\n`,
    'utf8',
  );
}
