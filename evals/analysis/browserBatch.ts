import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TrialReport } from '../metrics/metrics.js';
import type { EvalReport } from '../runners/runner.js';
import { resolveRunPath } from '../../src/run/runDir.js';
import type { ToolProfile } from '../../src/tools/index.js';

const ATOMIC_BROWSER_TOOLS = new Set([
  'navigate',
  'inspect_page',
  'click',
  'type',
  'scroll',
  'screenshot',
  'download',
]);

interface StoredEvalReport extends EvalReport {
  toolProfile: ToolProfile;
}

interface StoredMetrics {
  status?: string;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  peakContextTokens?: number;
  wallClockMs?: number;
}

interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultRecord {
  toolCallId: string;
  isError?: boolean;
  content: string;
}

export interface BrowserBatchTrialAnalysis {
  toolProfile: ToolProfile;
  reportPath: string;
  task: string;
  trial: number;
  runDir: string;
  completed: boolean;
  assertionAccuracy: number;
  graderLatencyMs: number;
  runStatus: string | null;
  turns: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  peakContextTokens: number | null;
  wallClockMs: number | null;
  approximateWeightedTokens: number;
  firstRequestPromptTokens: number | null;
  directAtomicBrowserCalls: number;
  batchCalls: number;
  batchErrors: number;
  nestedBrowserOperations: number;
  browserOperations: number;
  modelVisibleBrowserCalls: number;
  usedBatch: boolean;
}

export interface NumericSummary {
  mean: number | null;
  median: number | null;
}

export interface BrowserBatchAggregate {
  trials: number;
  completedTrials: number;
  completionRate: number;
  assertionAccuracy: number;
  adoptionTrials: number;
  adoptionRate: number;
  directAtomicBrowserCalls: number;
  batchCalls: number;
  batchErrors: number;
  nestedBrowserOperations: number;
  browserOperations: number;
  modelVisibleBrowserCalls: number;
  batchedOperationShare: number;
  operationsPerModelVisibleCall: number;
  actionsPerBatch: number;
  batchErrorRate: number;
  turns: NumericSummary;
  inputTokens: NumericSummary;
  outputTokens: NumericSummary;
  cacheReadInputTokens: NumericSummary;
  cacheCreationInputTokens: NumericSummary;
  peakContextTokens: NumericSummary;
  wallClockMs: NumericSummary;
  approximateWeightedTokens: NumericSummary;
  firstRequestPromptTokens: NumericSummary;
}

export interface BrowserBatchConditionAnalysis {
  toolProfile: ToolProfile;
  resultPaths: string[];
  trials: BrowserBatchTrialAnalysis[];
  overall: BrowserBatchAggregate;
  tasks: Record<string, BrowserBatchAggregate>;
}

export interface BrowserBatchExperimentAnalysis {
  conditions: Record<ToolProfile, BrowserBatchConditionAnalysis>;
  firstRequestPromptTokenDelta: number | null;
}

/** Analyze already-graded eval runs. Graders remain completely outside this path. */
export function analyzeBrowserBatchExperiment(input: {
  atomic: readonly string[];
  'batch-enabled': readonly string[];
}): BrowserBatchExperimentAnalysis {
  const atomic = analyzeCondition('atomic', input.atomic);
  const batchEnabled = analyzeCondition('batch-enabled', input['batch-enabled']);
  const controlPrefix = atomic.overall.firstRequestPromptTokens.median;
  const treatmentPrefix = batchEnabled.overall.firstRequestPromptTokens.median;

  return {
    conditions: { atomic, 'batch-enabled': batchEnabled },
    firstRequestPromptTokenDelta:
      controlPrefix === null || treatmentPrefix === null
        ? null
        : treatmentPrefix - controlPrefix,
  };
}

function analyzeCondition(
  toolProfile: ToolProfile,
  resultPaths: readonly string[],
): BrowserBatchConditionAnalysis {
  if (resultPaths.length === 0) {
    throw new Error(`${toolProfile} needs at least one eval result file`);
  }

  const trials: BrowserBatchTrialAnalysis[] = [];
  const absolutePaths = resultPaths.map((path) => resolve(path));
  for (const reportPath of absolutePaths) {
    const report = readEvalReport(reportPath);
    if (report.toolProfile !== toolProfile) {
      throw new Error(
        `${reportPath} is labeled ${JSON.stringify(report.toolProfile)}, expected ${toolProfile}`,
      );
    }
    for (const task of report.tasks) {
      task.trials.forEach((trial, index) => {
        trials.push(analyzeTrial(toolProfile, reportPath, task.task, index + 1, trial));
      });
    }
  }

  const taskNames = [...new Set(trials.map((trial) => trial.task))];
  return {
    toolProfile,
    resultPaths: absolutePaths,
    trials,
    overall: aggregateTrials(trials),
    tasks: Object.fromEntries(
      taskNames.map((task) => [
        task,
        aggregateTrials(trials.filter((trial) => trial.task === task)),
      ]),
    ),
  };
}

function analyzeTrial(
  toolProfile: ToolProfile,
  reportPath: string,
  task: string,
  trialNumber: number,
  grade: TrialReport,
): BrowserBatchTrialAnalysis {
  const metrics = readJson<StoredMetrics>(resolveRunPath(grade.runDir, 'metrics.json'));
  const events = readTranscript(resolveRunPath(grade.runDir, 'transcript.jsonl'));
  const calls: ToolCallRecord[] = [];
  const results = new Map<string, ToolResultRecord>();
  let firstRequestPromptTokens: number | null = null;

  for (const event of events) {
    if (event.type === 'tool_call' && isToolCall(event.call)) calls.push(event.call);
    if (event.type === 'tool_result' && isToolResult(event.result)) {
      results.set(event.result.toolCallId, event.result);
    }
    if (event.type === 'model_response' && event.turn === 1 && isRecord(event.response)) {
      const usage = event.response.usage;
      if (isRecord(usage)) {
        firstRequestPromptTokens =
          numberOrZero(usage.input_tokens) +
          numberOrZero(usage.cache_read_input_tokens) +
          numberOrZero(usage.cache_creation_input_tokens);
      }
    }
  }

  let directAtomicBrowserCalls = 0;
  let batchCalls = 0;
  let batchErrors = 0;
  let nestedBrowserOperations = 0;
  for (const call of calls) {
    if (ATOMIC_BROWSER_TOOLS.has(call.name)) directAtomicBrowserCalls += 1;
    if (call.name !== 'browser_batch') continue;
    batchCalls += 1;
    nestedBrowserOperations += batchActionCount(call.input);
    const result = results.get(call.id);
    if (result?.isError === true) batchErrors += 1;
    if (result !== undefined) {
      // A successful aggregate may itself be offloaded. Resolve the path
      // through the run confinement chokepoint before reading it.
      loadCompleteResultContent(grade.runDir, result.content);
    }
  }

  const inputTokens = numberOrZero(metrics.inputTokens);
  const outputTokens = numberOrZero(metrics.outputTokens);
  const cacheReadInputTokens = numberOrZero(metrics.cacheReadInputTokens);
  const cacheCreationInputTokens = numberOrZero(metrics.cacheCreationInputTokens);
  const browserOperations = directAtomicBrowserCalls + nestedBrowserOperations;
  const modelVisibleBrowserCalls = directAtomicBrowserCalls + batchCalls;

  return {
    toolProfile,
    reportPath,
    task,
    trial: trialNumber,
    runDir: grade.runDir,
    completed: grade.completed,
    assertionAccuracy: assertionAccuracy(grade),
    graderLatencyMs: grade.latencyMs,
    runStatus: typeof metrics.status === 'string' ? metrics.status : null,
    turns: numberOrNull(metrics.turns),
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    peakContextTokens: numberOrNull(metrics.peakContextTokens),
    wallClockMs: numberOrNull(metrics.wallClockMs),
    approximateWeightedTokens:
      inputTokens +
      1.25 * cacheCreationInputTokens +
      0.1 * cacheReadInputTokens +
      5 * outputTokens,
    firstRequestPromptTokens,
    directAtomicBrowserCalls,
    batchCalls,
    batchErrors,
    nestedBrowserOperations,
    browserOperations,
    modelVisibleBrowserCalls,
    usedBatch: batchCalls > 0,
  };
}

function aggregateTrials(trials: readonly BrowserBatchTrialAnalysis[]): BrowserBatchAggregate {
  if (trials.length === 0) throw new Error('cannot aggregate zero trials');
  const sum = (pick: (trial: BrowserBatchTrialAnalysis) => number): number =>
    trials.reduce((total, trial) => total + pick(trial), 0);
  const directAtomicBrowserCalls = sum((trial) => trial.directAtomicBrowserCalls);
  const batchCalls = sum((trial) => trial.batchCalls);
  const batchErrors = sum((trial) => trial.batchErrors);
  const nestedBrowserOperations = sum((trial) => trial.nestedBrowserOperations);
  const browserOperations = directAtomicBrowserCalls + nestedBrowserOperations;
  const modelVisibleBrowserCalls = directAtomicBrowserCalls + batchCalls;

  return {
    trials: trials.length,
    completedTrials: trials.filter((trial) => trial.completed).length,
    completionRate: mean(trials.map((trial) => Number(trial.completed)))!,
    assertionAccuracy: mean(trials.map((trial) => trial.assertionAccuracy))!,
    adoptionTrials: trials.filter((trial) => trial.usedBatch).length,
    adoptionRate: mean(trials.map((trial) => Number(trial.usedBatch)))!,
    directAtomicBrowserCalls,
    batchCalls,
    batchErrors,
    nestedBrowserOperations,
    browserOperations,
    modelVisibleBrowserCalls,
    batchedOperationShare: divide(nestedBrowserOperations, browserOperations),
    operationsPerModelVisibleCall: divide(browserOperations, modelVisibleBrowserCalls),
    actionsPerBatch: divide(nestedBrowserOperations, batchCalls),
    batchErrorRate: divide(batchErrors, batchCalls),
    turns: summarize(trials.map((trial) => trial.turns)),
    inputTokens: summarize(trials.map((trial) => trial.inputTokens)),
    outputTokens: summarize(trials.map((trial) => trial.outputTokens)),
    cacheReadInputTokens: summarize(trials.map((trial) => trial.cacheReadInputTokens)),
    cacheCreationInputTokens: summarize(
      trials.map((trial) => trial.cacheCreationInputTokens),
    ),
    peakContextTokens: summarize(trials.map((trial) => trial.peakContextTokens)),
    wallClockMs: summarize(trials.map((trial) => trial.wallClockMs)),
    approximateWeightedTokens: summarize(
      trials.map((trial) => trial.approximateWeightedTokens),
    ),
    firstRequestPromptTokens: summarize(
      trials.map((trial) => trial.firstRequestPromptTokens),
    ),
  };
}

/** Human-readable comparison; raw trial values remain available in the returned analysis. */
export function formatBrowserBatchAnalysis(analysis: BrowserBatchExperimentAnalysis): string {
  const lines = ['Browser batch experiment analysis'];
  for (const profile of ['atomic', 'batch-enabled'] as const) {
    const condition = analysis.conditions[profile];
    lines.push('', formatAggregate(profile, condition.overall));
    for (const [task, aggregate] of Object.entries(condition.tasks)) {
      lines.push(`  ${formatAggregate(task, aggregate)}`);
    }
  }
  lines.push(
    '',
    `First-request prompt-token delta (batch-enabled - atomic median): ` +
      formatNullable(analysis.firstRequestPromptTokenDelta),
  );
  return lines.join('\n');
}

function formatAggregate(label: string, aggregate: BrowserBatchAggregate): string {
  return (
    `${label}: quality ${pct(aggregate.assertionAccuracy)}, ` +
    `completion ${aggregate.completedTrials}/${aggregate.trials}, ` +
    `adoption ${aggregate.adoptionTrials}/${aggregate.trials}, ` +
    `browser ops/visible calls ${aggregate.browserOperations}/${aggregate.modelVisibleBrowserCalls} ` +
    `(${aggregate.operationsPerModelVisibleCall.toFixed(2)}), ` +
    `batched share ${pct(aggregate.batchedOperationShare)}, ` +
    `batch errors ${aggregate.batchErrors}/${aggregate.batchCalls}, ` +
    `turns median ${formatNullable(aggregate.turns.median)}, ` +
    `weighted tokens median ${formatNullable(aggregate.approximateWeightedTokens.median)}, ` +
    `wall ${formatNullable(aggregate.wallClockMs.median)}ms`
  );
}

function readEvalReport(path: string): StoredEvalReport {
  const report = readJson<Partial<StoredEvalReport>>(path);
  if (
    (report.toolProfile !== 'atomic' && report.toolProfile !== 'batch-enabled') ||
    !Array.isArray(report.tasks)
  ) {
    throw new Error(`${path} is not a labeled eval report`);
  }
  return report as StoredEvalReport;
}

function readTranscript(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error('event is not an object');
        return parsed;
      } catch (error) {
        throw new Error(
          `${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function loadCompleteResultContent(runDir: string, content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Plain-text errors and ordinary string results are not offload wrappers.
    return content;
  }
  if (isRecord(parsed) && typeof parsed.offloadedTo === 'string') {
    return readFileSync(resolveRunPath(runDir, parsed.offloadedTo), 'utf8');
  }
  return content;
}

function batchActionCount(input: unknown): number {
  if (!isRecord(input) || !Array.isArray(input.actions)) return 0;
  return input.actions.filter(
    (action) => isRecord(action) && typeof action.tool === 'string' && ATOMIC_BROWSER_TOOLS.has(action.tool),
  ).length;
}

function isToolCall(value: unknown): value is ToolCallRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    'input' in value
  );
}

function isToolResult(value: unknown): value is ToolResultRecord {
  return (
    isRecord(value) &&
    typeof value.toolCallId === 'string' &&
    typeof value.content === 'string'
  );
}

function assertionAccuracy(grade: TrialReport): number {
  return grade.assertions.filter((assertion) => assertion.passed).length / grade.assertions.length;
}

function summarize(values: readonly (number | null)[]): NumericSummary {
  const present = values.filter((value): value is number => value !== null);
  return { mean: mean(present), median: median(present) };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNullable(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}
