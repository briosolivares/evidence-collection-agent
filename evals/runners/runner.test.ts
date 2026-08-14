import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { finalizeManifest, initManifest } from '../../src/run/artifacts.js';
import { createRunDir } from '../../src/run/runDir.js';
import { generateRunId } from '../../src/run/runId.js';
import { TRANSCRIPT_FILENAME } from '../../src/run/transcript.js';
import { makeFakeRunTask } from './fakeAgent.js';
import { EvalRunCancelledError, runEvals } from './runner.js';
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
    headed: false,
    fetchOracle,
    grade,
  };
}

function passingTask(name: string, headed = false): EvalTask {
  return {
    ...stubTask(),
    name,
    taskText: `run ${name}`,
    headed,
    fetchOracle: async () => ({ task: name }),
    grade: async () => [{ name: 'complete', passed: true, detail: 'ok' }],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runEvals', () => {
  it('k trials produce k distinct run dirs, per-trial grades, and correct aggregation', async () => {
    const report = await runEvals([stubTask()], 3, {
      runTask: makeFakeRunTask(baseDir),
      concurrency: 2,
      model: 'fake-model',
    });

    expect(report.k).toBe(3);
    expect(report.concurrency).toBe(2);
    expect(report.model).toBe('fake-model');
    expect(report.tasks).toHaveLength(1);
    const task = report.tasks[0]!;
    expect(task.task).toBe('stub');
    expect(task.trials).toHaveLength(3);

    const runDirs = task.trials.map((t) => t.runDir);
    expect(new Set(runDirs).size).toBe(3);
    for (const dir of runDirs) {
      expect(dir).toBeDefined();
      expect(statSync(dir!).isDirectory()).toBe(true);
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
      concurrency: 1,
      model: 'fake-model',
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
      concurrency: 1,
      model: 'fake-model',
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
      expect(oracleArg).toEqual({ expectedFile: 'artifacts/answer.md' });
    });
  });

  it('awaits onTrialGraded after every trial with that trial\'s grade, in order', async () => {
    const seen: Array<{ taskName: string; trialIndex: number; runDir: string }> = [];
    const report = await runEvals([stubTask()], 3, {
      runTask: makeFakeRunTask(baseDir),
      concurrency: 1,
      model: 'fake-model',
      onTrialGraded: async (job, grade) => {
        // Async on purpose: the runner must await the hook (persistence
        // must complete before the next trial can crash the process).
        await Promise.resolve();
        expect(grade.assertions.length).toBeGreaterThan(0);
        seen.push({ taskName: job.taskName, trialIndex: job.trialIndex, runDir: grade.runDir! });
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.trialIndex)).toEqual([0, 1, 2]);
    for (const [i, s] of seen.entries()) {
      expect(s.taskName).toBe('stub');
      expect(s.runDir).toBe(report.tasks[0]!.trials[i]!.runDir);
    }
  });

  it('rejects k < 1 and an empty task list; a grader asserting nothing errors its trial', async () => {
    const deps = {
      runTask: makeFakeRunTask(baseDir),
      concurrency: 1,
      model: 'fake-model',
    };

    await expect(runEvals([stubTask()], 0, deps)).rejects.toThrow(/positive integer/);
    await expect(runEvals([], 1, deps)).rejects.toThrow(/no tasks/);
    await expect(runEvals([stubTask()], 1, { ...deps, concurrency: 0 })).rejects.toThrow(
      /concurrency.*positive integer/,
    );

    const silent: Grader = () => [];
    const report = await runEvals([{ ...stubTask(), grade: silent }], 1, deps);
    const trial = report.tasks[0]!.trials[0]!;
    expect(trial.error).toMatch(/no assertions/);
    expect(trial.completed).toBe(false);
    expect(report.tasks[0]!.taskPassed).toBe(false);
    expect(report.tasks[0]!.accuracy).toBe(0);
  });

  it('caps headless work at 3, headed work at 1, and allows all four to overlap', async () => {
    const fourStarted = deferred();
    const release = deferred();
    let started = 0;
    let normalActive = 0;
    let headedActive = 0;
    let totalActive = 0;
    let maxNormal = 0;
    let maxHeaded = 0;
    let maxTotal = 0;

    const reportPromise = runEvals(
      [passingTask('normal'), passingTask('headed', true)],
      3,
      {
        concurrency: 3,
        model: 'fake-model',
        runTask: async (_taskText, opts) => {
          started += 1;
          if (opts.headed) headedActive += 1;
          else normalActive += 1;
          totalActive += 1;
          maxNormal = Math.max(maxNormal, normalActive);
          maxHeaded = Math.max(maxHeaded, headedActive);
          maxTotal = Math.max(maxTotal, totalActive);
          if (started === 4) fourStarted.resolve();
          await release.promise;
          if (opts.headed) headedActive -= 1;
          else normalActive -= 1;
          totalActive -= 1;
          return { runDir: `/runs/${opts.taskName}-${opts.trialIndex}` };
        },
      },
    );

    await fourStarted.promise;
    expect({ normalActive, headedActive, totalActive }).toEqual({
      normalActive: 3,
      headedActive: 1,
      totalActive: 4,
    });
    release.resolve();
    const report = await reportPromise;

    expect({ maxNormal, maxHeaded, maxTotal }).toEqual({
      maxNormal: 3,
      maxHeaded: 1,
      maxTotal: 4,
    });
    expect(report.tasks.map((task) => task.task)).toEqual(['normal', 'headed']);
  });

  it('keeps report slots ordered when concurrent trials finish in reverse order', async () => {
    const allStarted = deferred();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const reportPromise = runEvals(
      [passingTask('alpha'), passingTask('beta')],
      2,
      {
        concurrency: 4,
        model: 'fake-model',
        runTask: async (_taskText, opts) => {
          const key = `${opts.taskName}-${opts.trialIndex}`;
          const gate = deferred();
          gates.set(key, gate);
          if (gates.size === 4) allStarted.resolve();
          await gate.promise;
          return { runDir: `/runs/${key}` };
        },
      },
    );

    await allStarted.promise;
    for (const key of ['beta-1', 'beta-0', 'alpha-1', 'alpha-0']) {
      gates.get(key)!.resolve();
      await Promise.resolve();
    }
    const report = await reportPromise;

    expect(report.tasks.map((task) => task.trials.map((trial) => trial.runDir))).toEqual([
      ['/runs/alpha-0', '/runs/alpha-1'],
      ['/runs/beta-0', '/runs/beta-1'],
    ]);
  });

  it('serializes grading without holding a browser worker slot', async () => {
    const gradingStarted = deferred();
    const thirdRunStarted = deferred();
    const releaseRuns = deferred();
    const releaseGrading = deferred();
    let gradingActive = 0;
    let maxGrading = 0;
    const task = passingTask('pipeline');
    task.grade = async () => {
      gradingActive += 1;
      maxGrading = Math.max(maxGrading, gradingActive);
      gradingStarted.resolve();
      await releaseGrading.promise;
      gradingActive -= 1;
      return [{ name: 'complete', passed: true, detail: 'ok' }];
    };

    const reportPromise = runEvals([task], 3, {
      concurrency: 2,
      model: 'fake-model',
      runTask: async (_taskText, opts) => {
        if (opts.trialIndex === 0) return { runDir: '/runs/pipeline-0' };
        if (opts.trialIndex === 2) thirdRunStarted.resolve();
        await releaseRuns.promise;
        return { runDir: `/runs/pipeline-${opts.trialIndex}` };
      },
    });

    await Promise.all([gradingStarted.promise, thirdRunStarted.promise]);
    releaseRuns.resolve();
    releaseGrading.resolve();
    await reportPromise;
    expect(maxGrading).toBe(1);
  });

  it('records a throwing trial as errored and finishes the rest of the batch', async () => {
    const fakeRunTask = makeFakeRunTask(baseDir);
    const graded: Array<{ trialNumber: number; error?: string }> = [];
    const runTask: RunTaskFn = async (taskText, opts) => {
      if (opts.trialIndex === 0) throw new Error('first trial failed');
      return fakeRunTask(taskText, opts);
    };

    const report = await runEvals([passingTask('resilience')], 3, {
      runTask,
      concurrency: 2,
      model: 'fake-model',
      onTrialGraded: (job, grade) => {
        graded.push({ trialNumber: job.trialNumber, ...(grade.error === undefined ? {} : { error: grade.error }) });
      },
    });

    const trials = report.tasks[0]!.trials;
    expect(trials).toHaveLength(3);
    expect(trials[0]).toMatchObject({ error: 'first trial failed', completed: false, assertions: [] });
    expect(trials[0]!.runDir).toBeUndefined();
    for (const trial of trials.slice(1)) {
      expect(trial.error).toBeUndefined();
      expect(trial.completed).toBe(true);
    }
    expect(report.tasks[0]!.taskPassed).toBe(false);
    expect(report.tasks[0]!.accuracy).toBeCloseTo(2 / 3);
    // The errored trial is persisted through the same serialized hook as grades.
    expect(graded.find((g) => g.trialNumber === 1)).toEqual({ trialNumber: 1, error: 'first trial failed' });
  });

  it('a cancelled trial stops the batch as cancelled, never as a recorded failure', async () => {
    // Cancellation is an interrupt, not a verdict: an EvalRunCancelledError
    // echoing up from a trial must abort the batch, not land in the report
    // as an errored FAIL the way an ordinary throwing trial does.
    const fakeRunTask = makeFakeRunTask(baseDir);
    const graded: number[] = [];
    let calls = 0;
    const runTask: RunTaskFn = async (taskText, opts) => {
      calls += 1;
      if (opts.trialIndex === 1) throw new EvalRunCancelledError();
      return fakeRunTask(taskText, opts);
    };

    await expect(
      runEvals([passingTask('interrupt')], 3, {
        runTask,
        concurrency: 1,
        model: 'fake-model',
        onTrialGraded: (job) => {
          graded.push(job.trialNumber);
        },
      }),
    ).rejects.toBeInstanceOf(EvalRunCancelledError);
    // The third trial never started, and the cancelled second trial was
    // never recorded as a grade.
    expect(calls).toBe(2);
    expect(graded).not.toContain(2);
    expect(graded).not.toContain(3);
  });

  it('propagates caller cancellation to every active trial and starts no more', async () => {
    const controller = new AbortController();
    const twoStarted = deferred();
    let started = 0;
    let aborted = 0;
    const reportPromise = runEvals([passingTask('cancel')], 5, {
      concurrency: 2,
      model: 'fake-model',
      signal: controller.signal,
      runTask: async (_taskText, opts) => {
        started += 1;
        if (started === 2) twoStarted.resolve();
        return await new Promise((_resolve, reject) => {
          opts.signal.addEventListener(
            'abort',
            () => {
              aborted += 1;
              reject(opts.signal.reason);
            },
            { once: true },
          );
        });
      },
    });

    await twoStarted.promise;
    controller.abort();
    await expect(reportPromise).rejects.toThrow(/cancelled/);
    expect({ started, aborted }).toEqual({ started: 2, aborted: 2 });
  });
});
