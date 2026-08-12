import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvalReport } from '../../evals/runners/runner.js';
import type { EvalTask } from '../../evals/types.js';
import {
  discoverEvalTasks,
  startEvalBatch,
  usableStartUrl,
  type EvalRunner,
} from '../../src/tui/bridge/evalSession.js';
import type { StoreAction } from '../../src/tui/store/reducer.js';
import type { RunOutcome } from '../../src/tui/bridge/runSession.js';

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'sherlock-evals-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('discoverEvalTasks', () => {
  it('includes only directories containing task.json, sorted', () => {
    mkdirSync(join(fixtureDir, 'edgar'));
    writeFileSync(join(fixtureDir, 'edgar', 'task.json'), '{"task":"x"}');
    mkdirSync(join(fixtureDir, 'stub'));
    writeFileSync(join(fixtureDir, 'stub', 'task.json'), '{"task":"y"}');
    mkdirSync(join(fixtureDir, 'not-a-task'));
    writeFileSync(join(fixtureDir, 'loose-file.ts'), 'export {}');

    expect(discoverEvalTasks(fixtureDir)).toEqual(['edgar', 'stub']);
  });

  it('returns empty for a missing directory', () => {
    expect(discoverEvalTasks(join(fixtureDir, 'nope'))).toEqual([]);
  });
});

describe('usableStartUrl', () => {
  it('passes HTTP(S) URLs through and drops everything else', () => {
    expect(usableStartUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(usableStartUrl('http://example.com')).toBe('http://example.com');
    expect(usableStartUrl('about:blank')).toBeUndefined();
    expect(usableStartUrl('file:///etc/passwd')).toBeUndefined();
    expect(usableStartUrl('not a url')).toBeUndefined();
    expect(usableStartUrl(undefined)).toBeUndefined();
  });
});

interface BatchFixture {
  actions: StoreAction[];
  runnerCalls: { task: string; startUrl?: string }[];
  gradeCalls: unknown[][];
  written: { report: EvalReport; dir: string }[];
}

function makeFixture(outcomes: RunOutcome[]): BatchFixture & {
  runner: EvalRunner;
  loadTask: (dir: string, name: string) => Promise<EvalTask>;
  writeResultsFn: (report: EvalReport, dir: string) => string;
} {
  const fixture: BatchFixture = { actions: [], runnerCalls: [], gradeCalls: [], written: [] };
  let call = 0;

  const runner: EvalRunner = (task, onEvent, opts) => {
    fixture.runnerCalls.push({ task, ...(opts?.startUrl === undefined ? {} : { startUrl: opts.startUrl }) });
    const outcome = outcomes[Math.min(call, outcomes.length - 1)]!;
    call += 1;
    onEvent({ type: 'run_started', task, at: 0 });
    if (outcome.status === 'completed') {
      onEvent({
        type: 'run_finished',
        outcome: 'completed',
        finalText: '',
        runDir: outcome.runDir,
        at: 1,
      });
    } else if (outcome.status === 'cancelled') {
      onEvent({ type: 'run_cancelled', at: 1 });
    } else if (outcome.status === 'failed') {
      onEvent({ type: 'run_failed', message: outcome.message, at: 1 });
    }
    return { cancel: vi.fn(), done: Promise.resolve(outcome) };
  };

  const loadTask = async (_dir: string, name: string): Promise<EvalTask> => ({
    name,
    taskText: `run the ${name} investigation`,
    startUrl: `https://start.example/${name}`,
    requiresAuth: false,
    fetchOracle: async () => ({ oracleFor: name }),
    grade: (runDir, oracle) => {
      fixture.gradeCalls.push([runDir, oracle]);
      return [
        { name: 'file exists', passed: true, detail: 'found' },
        { name: 'hash matches', passed: false, detail: 'mismatch' },
      ];
    },
  });

  const writeResultsFn = (report: EvalReport, dir: string): string => {
    fixture.written.push({ report, dir });
    return join(dir, 'results-test.json');
  };

  return { ...fixture, runner, loadTask, writeResultsFn };
}

describe('startEvalBatch', () => {
  it('runs trials sequentially with ordered framing, verdicts, report, and persistence', async () => {
    const fixture = makeFixture([
      { status: 'completed', finalText: '', runDir: '/runs/t1' },
      { status: 'completed', finalText: '', runDir: '/runs/t2' },
    ]);

    const handle = startEvalBatch(['stub'], 2, {
      onAction: (action) => fixture.actions.push(action),
      evalsDir: fixtureDir,
      resultsDir: '/tmp/results-dir',
      runner: fixture.runner,
      loadTask: fixture.loadTask,
      writeResultsFn: fixture.writeResultsFn,
      now: () => 5_000,
    });
    const result = await handle.done;
    expect(result).toBe('completed');

    const types = fixture.actions.map((action) => action.type);
    expect(types).toEqual([
      'evals_started',
      'eval_trial_started',
      'run_started',
      'run_finished',
      'eval_trial_done',
      'eval_trial_started',
      'run_started',
      'run_finished',
      'eval_trial_done',
      'eval_report_ready',
      'evals_finished',
    ]);

    // Trials pass the task text and startUrl through the live pipeline.
    expect(fixture.runnerCalls).toEqual([
      { task: 'run the stub investigation', startUrl: 'https://start.example/stub' },
      { task: 'run the stub investigation', startUrl: 'https://start.example/stub' },
    ]);

    // The grader saw exactly the run dir and the freshly fetched oracle.
    expect(fixture.gradeCalls).toEqual([
      ['/runs/t1', { oracleFor: 'stub' }],
      ['/runs/t2', { oracleFor: 'stub' }],
    ]);

    // Verdicts carried per-assertion results.
    const trialDone = fixture.actions.find((action) => action.type === 'eval_trial_done');
    expect(trialDone).toMatchObject({
      task: 'stub',
      trial: 1,
      k: 2,
      assertions: [
        { name: 'file exists', passed: true },
        { name: 'hash matches', passed: false },
      ],
    });

    // Report assembled through formatReport and persisted via writeResults.
    expect(fixture.written).toHaveLength(1);
    expect(fixture.written[0]?.dir).toBe('/tmp/results-dir');
    expect(fixture.written[0]?.report.k).toBe(2);
    expect(fixture.written[0]?.report.tasks[0]?.trials).toHaveLength(2);
    const reportAction = fixture.actions.find((action) => action.type === 'eval_report_ready');
    expect((reportAction as { text: string }).text).toContain('Eval report — k=2');
    expect((reportAction as { text: string }).text).toContain('stub: accuracy 50.0%');
    expect((reportAction as { text: string }).text).toContain('results-test.json');
  });

  it('a cancelled trial skips every remaining trial and writes no report', async () => {
    const fixture = makeFixture([
      { status: 'completed', finalText: '', runDir: '/runs/t1' },
      { status: 'cancelled' },
    ]);

    const handle = startEvalBatch(['stub', 'edgar'], 2, {
      onAction: (action) => fixture.actions.push(action),
      evalsDir: fixtureDir,
      resultsDir: '/tmp/results-dir',
      runner: fixture.runner,
      loadTask: fixture.loadTask,
      writeResultsFn: fixture.writeResultsFn,
      now: () => 5_000,
    });
    const result = await handle.done;

    expect(result).toBe('cancelled');
    // Only the first trial graded; no report persisted; batch closed.
    expect(fixture.gradeCalls).toHaveLength(1);
    expect(fixture.written).toHaveLength(0);
    expect(fixture.runnerCalls).toHaveLength(2); // second trial started, then cancelled
    const types = fixture.actions.map((action) => action.type);
    expect(types.at(-1)).toBe('evals_finished');
    expect(types).not.toContain('eval_report_ready');
    expect(
      fixture.actions.some(
        (action) => action.type === 'notice' && action.text.includes('interrupted'),
      ),
    ).toBe(true);
  });

  it('a failed trial run stops the batch with an error', async () => {
    const fixture = makeFixture([{ status: 'failed', message: 'browser died' }]);
    const handle = startEvalBatch(['stub'], 1, {
      onAction: (action) => fixture.actions.push(action),
      evalsDir: fixtureDir,
      resultsDir: '/tmp/results-dir',
      runner: fixture.runner,
      loadTask: fixture.loadTask,
      writeResultsFn: fixture.writeResultsFn,
    });
    expect(await handle.done).toBe('failed');
    const types = fixture.actions.map((action) => action.type);
    expect(types).toContain('eval_error');
    expect(types.at(-1)).toBe('evals_finished');
  });
});
