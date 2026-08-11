import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateRunId } from '../../src/run/runId.js';
import type { EvalReport } from './runner.js';

/**
 * Render an eval report as human-readable text: per task, the aggregate
 * metrics line (accuracy, completion, task pass/fail, mean latency), then
 * each trial with its run dir and assertion results — failed assertions
 * carry their detail.
 *
 * @param report - a report from runEvals
 * @returns the rendered multi-line text, without a trailing newline;
 *   printing is left to the caller (the CLI edge)
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `Eval report — k=${report.k}, model ${report.model}, started ${report.startedAt}`,
  ];

  for (const task of report.tasks) {
    const completions = task.trials.filter((t) => t.completed).length;
    lines.push(
      '',
      `${task.task}: accuracy ${(task.accuracy * 100).toFixed(1)}%  ` +
        `completion ${completions}/${task.k}  ` +
        `task ${task.taskPassed ? 'PASS' : 'FAIL'}  ` +
        `mean latency ${Math.round(task.meanLatencyMs)}ms`,
    );
    task.trials.forEach((trial, i) => {
      const passed = trial.assertions.filter((a) => a.passed).length;
      lines.push(
        `  trial ${i + 1}: ${passed}/${trial.assertions.length} assertions  ` +
          `${Math.round(trial.latencyMs)}ms  ${trial.runDir}`,
      );
      for (const a of trial.assertions) {
        lines.push(a.passed ? `    pass  ${a.name}` : `    FAIL  ${a.name} — ${a.detail}`);
      }
    });
  }

  const passedTasks = report.tasks.filter((t) => t.taskPassed).length;
  lines.push('', `${passedTasks}/${report.tasks.length} tasks passed`);
  return lines.join('\n');
}

/**
 * Write an eval report to a fresh results JSON file.
 *
 * @param report - a report from runEvals, written verbatim
 * @param resultsDir - directory for results files; created if missing
 * @returns the absolute path of the new file — <resultsDir>/<run-id>.json,
 *   named with a fresh run id so repeated evals never overwrite each other;
 *   its contents parse back to a deep-equal copy of the report
 */
export function writeResults(report: EvalReport, resultsDir: string): string {
  const dir = resolve(resultsDir);
  mkdirSync(dir, { recursive: true });
  const taskNames = report.tasks.map((t) => t.task).join(' ');
  const path = join(dir, `${generateRunId(`eval ${taskNames}`)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
