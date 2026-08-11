import { describe, expect, it } from 'vitest';

import { fractionPassed, isComplete, summarizeTask, type TrialGrade } from './metrics.js';
import type { AssertionResult } from '../types.js';

/** Build a synthetic assertion result. */
function check(passed: boolean, name = 'check'): AssertionResult {
  return { name, passed, detail: passed ? 'held' : 'did not hold' };
}

/** Build a synthetic trial whose assertions pass/fail as given. */
function trial(passes: boolean[], latencyMs = 100): TrialGrade {
  return {
    runDir: '/runs/synthetic',
    assertions: passes.map((p, i) => check(p, `check-${i}`)),
    latencyMs,
  };
}

describe('metric math', () => {
  it('k=1 with all assertions passing: accuracy 1, trial complete, task passes', () => {
    const report = summarizeTask('t', [trial([true, true])]);

    expect(report.k).toBe(1);
    expect(report.accuracy).toBe(1);
    expect(report.trials[0]!.completed).toBe(true);
    expect(report.taskPassed).toBe(true);
  });

  it('k=1 with a partial pass: accuracy strictly between 0 and 1, task fails', () => {
    const report = summarizeTask('t', [trial([true, false])]);

    expect(report.accuracy).toBe(0.5);
    expect(report.trials[0]!.completed).toBe(false);
    expect(report.taskPassed).toBe(false);
  });

  it('all trials failing every assertion: accuracy 0, no completions, task fails', () => {
    const report = summarizeTask('t', [trial([false, false]), trial([false, false])]);

    expect(report.accuracy).toBe(0);
    expect(report.trials.every((t) => !t.completed)).toBe(true);
    expect(report.taskPassed).toBe(false);
  });

  it('partial passes across trials: accuracy strictly between 0 and 1 while completion is 0', () => {
    // Trial fractions 2/4 and 3/4 → accuracy (0.5 + 0.75) / 2 = 0.625.
    const report = summarizeTask('t', [
      trial([true, false, true, false]),
      trial([true, true, true, false]),
    ]);

    expect(report.accuracy).toBeCloseTo(0.625, 10);
    expect(report.accuracy).toBeGreaterThan(0);
    expect(report.accuracy).toBeLessThan(1);
    expect(report.trials.filter((t) => t.completed)).toHaveLength(0);
    expect(report.taskPassed).toBe(false);
  });

  it('one failed trial among passing ones flips task-pass to false', () => {
    const report = summarizeTask('t', [
      trial([true, true, true]),
      trial([true, true, false]),
    ]);

    expect(report.trials.map((t) => t.completed)).toEqual([true, false]);
    expect(report.taskPassed).toBe(false);
    expect(report.accuracy).toBeCloseTo((1 + 2 / 3) / 2, 10);
  });

  it('mean latency averages the trials', () => {
    const report = summarizeTask('t', [trial([true], 100), trial([true], 300)]);

    expect(report.meanLatencyMs).toBe(200);
  });

  it('refuses zero assertions and zero trials — harness bugs, not scores', () => {
    expect(() => fractionPassed([])).toThrow();
    expect(() => isComplete([])).toThrow();
    expect(() => summarizeTask('t', [])).toThrow();
  });
});
