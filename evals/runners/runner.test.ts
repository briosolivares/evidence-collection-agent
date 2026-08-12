import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { finalizeManifest, initManifest } from '../../src/run/artifacts.js';
import { createRunDir } from '../../src/run/runDir.js';
import { generateRunId } from '../../src/run/runId.js';
import { TRANSCRIPT_FILENAME } from '../../src/run/transcript.js';
import { makeFakeRunTask } from './fakeAgent.js';
import { runEvals } from './runner.js';
import { grade } from '../datasets/stub/grader/grader.js';
import { fetchOracle } from '../datasets/stub/oracle/oracle.js';
import type { AssertionResult, EvalTask, Grader, RunTaskFn } from '../types.js';

// All fake-agent run dirs land in a temp dir; the suite stays hermetic.
let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'eval-runner-test-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** The stub task as the runner sees it, wired to the real stub grader/oracle. */
function stubTask(): EvalTask {
  return {
    name: 'stub',
    taskText: 'write the answer',
    startUrl: 'about:blank',
    fetchOracle,
    grade,
  };
}

describe('runEvals', () => {
  it('k trials produce k distinct run dirs, per-trial grades, and correct aggregation', async () => {
    const report = await runEvals([stubTask()], 3, {
      runTask: makeFakeRunTask(baseDir),
      model: 'fake-model',
      toolProfile: 'batch-enabled',
    });

    expect(report.k).toBe(3);
    expect(report.model).toBe('fake-model');
    expect(report.toolProfile).toBe('batch-enabled');
    expect(report.tasks).toHaveLength(1);
    const task = report.tasks[0]!;
    expect(task.task).toBe('stub');
    expect(task.trials).toHaveLength(3);

    const runDirs = task.trials.map((t) => t.runDir);
    expect(new Set(runDirs).size).toBe(3);
    for (const dir of runDirs) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }

    for (const trial of task.trials) {
      expect(trial.assertions.length).toBeGreaterThan(0);
      expect(trial.assertions.every((a) => a.passed)).toBe(true);
      expect(trial.completed).toBe(true);
      expect(trial.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(task.accuracy).toBe(1);
    expect(task.taskPassed).toBe(true);
  });

  it('a trial without the deliverable fails grading and flips task-pass to false', async () => {
    // Second trial produces an empty (but manifest-valid) run — no answer.md.
    const good = makeFakeRunTask(baseDir);
    let call = 0;
    const flaky: RunTaskFn = async (taskText, opts) => {
      call += 1;
      if (call !== 2) return good(taskText, opts);
      const runDir = createRunDir(baseDir, generateRunId());
      initManifest(runDir, taskText);
      finalizeManifest(runDir);
      return { runDir };
    };

    const report = await runEvals([stubTask()], 2, {
      runTask: flaky,
      model: 'fake-model',
      toolProfile: 'atomic',
    });

    const task = report.tasks[0]!;
    expect(task.trials.map((t) => t.completed)).toEqual([true, false]);
    expect(task.taskPassed).toBe(false);
    expect(task.accuracy).toBeGreaterThan(0);
    expect(task.accuracy).toBeLessThan(1);
  });

  it('hands a grader exactly the run dir path and oracle data — never a transcript path', async () => {
    const calls: unknown[][] = [];
    const spyGrader = ((...args: unknown[]) => {
      calls.push(args);
      return [{ name: 'noop', passed: true, detail: 'spy' }] satisfies AssertionResult[];
    }) as Grader;

    const report = await runEvals([{ ...stubTask(), grade: spyGrader }], 2, {
      runTask: makeFakeRunTask(baseDir),
      model: 'fake-model',
      toolProfile: 'atomic',
    });

    expect(calls).toHaveLength(2);
    calls.forEach((args, i) => {
      // Interface shape: two arguments, no more — nowhere to smuggle a
      // transcript path in.
      expect(args).toHaveLength(2);
      const [runDirArg, oracleArg] = args;

      // First argument is the trial's run *directory*, not a file inside it.
      expect(runDirArg).toBe(report.tasks[0]!.trials[i]!.runDir);
      expect(statSync(runDirArg as string).isDirectory()).toBe(true);
      expect(runDirArg).not.toContain('transcript');

      // The run does have a transcript — it just was never handed over.
      expect(existsSync(join(runDirArg as string, TRANSCRIPT_FILENAME))).toBe(true);

      // Second argument is the oracle data, verbatim.
      expect(oracleArg).toEqual({ expectedFile: 'answer.md' });
    });
  });

  it('awaits onTrialGraded after every trial with that trial\'s grade, in order', async () => {
    const seen: Array<{ taskName: string; trialIndex: number; runDir: string }> = [];
    const report = await runEvals([stubTask()], 3, {
      runTask: makeFakeRunTask(baseDir),
      model: 'fake-model',
      toolProfile: 'atomic',
      onTrialGraded: async (taskName, trialIndex, grade) => {
        // Async on purpose: the runner must await the hook (persistence
        // must complete before the next trial can crash the process).
        await Promise.resolve();
        expect(grade.assertions.length).toBeGreaterThan(0);
        seen.push({ taskName, trialIndex, runDir: grade.runDir });
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.trialIndex)).toEqual([0, 1, 2]);
    for (const [i, s] of seen.entries()) {
      expect(s.taskName).toBe('stub');
      expect(s.runDir).toBe(report.tasks[0]!.trials[i]!.runDir);
    }
  });

  it('rejects k < 1, an empty task list, and a grader returning no assertions', async () => {
    const deps = {
      runTask: makeFakeRunTask(baseDir),
      model: 'fake-model',
      toolProfile: 'atomic' as const,
    };

    await expect(runEvals([stubTask()], 0, deps)).rejects.toThrow(/positive integer/);
    await expect(runEvals([], 1, deps)).rejects.toThrow(/no tasks/);

    const silent: Grader = () => [];
    await expect(runEvals([{ ...stubTask(), grade: silent }], 1, deps)).rejects.toThrow(
      /no assertions/,
    );
  });
});
