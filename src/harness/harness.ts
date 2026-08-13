import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { METRICS_FILENAME, type RunMetrics } from '../loop/agentLoop.js';

// Small shared helpers for runTask.ts's initializer → worker → judge outer
// loop (see .agents/planning/2026-08-12-research-quality-harness/judge-design.md
// and judge-implementation.md's step 3). Nothing here decides the loop's
// control flow — that lives in runTask.ts — these are just the run-dir I/O
// bits that would otherwise clutter it: archiving each worker cycle's
// metrics.json before the next cycle overwrites it, folding the archived
// per-cycle metrics into one rollup, and writing the harness's own
// diagnostics file.

/** Name of the harness diagnostics file at the run-dir root. Written once,
 * at the end of the cycle loop, in harness-mode runs only — judge-less runs
 * (no `config.harness`) never produce this file. */
export const HARNESS_FILENAME = 'harness.json';

/**
 * One worker cycle's outcome, as recorded for harness.json diagnostics.
 * `verdict` and `reason` are both absent when the judge never ran for this
 * cycle (a `budget_exceeded` worker result skips the judge outright — see
 * judge-design.md's "Loop" section, "budgets end runs"). `reason` is also
 * absent on a `done` verdict, whose JudgeVerdict.reason is always the empty
 * string (see judge.ts's parseVerdict) — nothing worth recording.
 */
export interface HarnessCycleRecord {
  /** 1-based cycle index. */
  cycle: number;
  /** This cycle's `LoopResult.status` ('completed' or 'budget_exceeded'). */
  workerStatus: string;
  /** The judge's verdict, when the judge ran this cycle. */
  verdict?: 'done' | 'continue';
  /** The judge's reason, when non-empty. */
  reason?: string;
  /** The error message when the judge itself crashed this cycle (an
   * infrastructure failure, never a verdict) — the run still ends with the
   * worker's completed result, and this field is the diagnostic trail.
   * Mutually exclusive with `verdict`/`reason`. */
  judgeError?: string;
}

/** Harness-mode run diagnostics: the initializer's model plus one record
 * per worker cycle. Written by writeHarnessDiagnostics; nothing else reads
 * or writes harness.json. */
export interface HarnessDiagnostics {
  /** Which model produced this run's INTENT.md/CONTRACT.md. Always the
   * initializer's configured model id, independent of whether production's
   * makeInitializerCallModel or a test seam actually ran the call — this
   * field documents which role wrote the contract, not which function
   * object answered it. */
  initializer: { model: string };
  /** One entry per worker cycle that ran, in cycle order. */
  cycles: HarnessCycleRecord[];
}

/**
 * Write the harness's diagnostics file at the run-dir root.
 *
 * @param runDir - absolute path to the run directory
 * @param diagnostics - the complete diagnostics for this run (see
 *   HarnessDiagnostics)
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

/**
 * Archive one worker cycle's metrics.json before the next cycle's
 * runAgentLoop invocation would overwrite it.
 *
 * @param runDir - absolute path to the run directory; must currently hold
 *   `metrics.json`, written by the cycle's own (already-resolved)
 *   runAgentLoop call — never call this after a cycle throws, since a
 *   thrown cycle's metrics.json (status 'failed', written by the loop's own
 *   crash path) must stay exactly where the loop wrote it (no rollup on a
 *   crashed or aborted run — see judge-design.md and the harness's AbortError
 *   contract)
 * @returns the cycle's parsed RunMetrics, for the caller to fold into the
 *   eventual rollup
 * @throws if metrics.json is missing or is not valid RunMetrics JSON
 */
export function archiveCycleMetrics(runDir: string, cycle: number): RunMetrics {
  const metricsPath = join(runDir, METRICS_FILENAME);
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as RunMetrics;
  renameSync(metricsPath, join(runDir, `metrics-cycle-${cycle}.json`));
  return metrics;
}

/**
 * Fold every archived worker cycle's metrics into the final metrics.json
 * shape existing consumers already expect (see agentLoop.ts's RunMetrics):
 * turn and token counters sum across cycles (each is itself a per-run total,
 * so summing per-cycle totals gives the run's grand total); peakContextTokens
 * is the max across cycles (a depth number, not additive); wallClockMs sums
 * each cycle's own wall-clock (the harness's own initializer/judge time
 * between cycles is not counted — this is worker time only, matching what a
 * single-cycle run's metrics.json has always measured).
 *
 * @param status - the run's terminal status (the final cycle's
 *   LoopResult.status)
 * @param perCycle - one RunMetrics per worker cycle that ran, in any order
 * @returns the rolled-up RunMetrics, ready to write as metrics.json
 */
export function rollupCycleMetrics(
  status: RunMetrics['status'],
  perCycle: readonly RunMetrics[],
): RunMetrics {
  const totals = perCycle.reduce(
    (acc, cycle) => ({
      turns: acc.turns + cycle.turns,
      inputTokens: acc.inputTokens + cycle.inputTokens,
      outputTokens: acc.outputTokens + cycle.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + cycle.cacheReadInputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + cycle.cacheCreationInputTokens,
      peakContextTokens: Math.max(acc.peakContextTokens, cycle.peakContextTokens),
      wallClockMs: acc.wallClockMs + cycle.wallClockMs,
    }),
    {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      peakContextTokens: 0,
      wallClockMs: 0,
    },
  );
  return { status, ...totals };
}

/**
 * Write the harness's rollup as the run's metrics.json.
 *
 * @param runDir - absolute path to the run directory; metrics.json must not
 *   currently exist here (the final cycle's own metrics.json was already
 *   archived by archiveCycleMetrics before this is called)
 * @returns nothing; writes `<runDir>/metrics.json` in the same
 *   pretty-printed shape agentLoop.ts's writeMetrics uses, so every existing
 *   consumer (evals, the /runs browser) keeps reading a valid RunMetrics
 *   regardless of how many cycles produced it
 */
export function writeMetricsRollup(runDir: string, metrics: RunMetrics): void {
  writeFileSync(
    join(runDir, METRICS_FILENAME),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );
}
