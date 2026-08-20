import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, readManifest, writeArtifact } from '../../src/run/artifacts.js';

type Scenario =
  | 'contract'
  | 'model_in_flight'
  | 'pre_tool'
  | 'uncertain_tool'
  | 'post_tool'
  | 'cancelled_workspace_recovery'
  | 'verifying'
  | 'worker_accounting'
  | 'deterministic_feedback'
  | 'verifier_correction';
type Invocation = 'initial' | 'resume';

interface HarnessMessage {
  type: string;
  boundary?: string;
  outcome?: { status: string; [key: string]: unknown };
  message?: string;
  [key: string]: unknown;
}

interface FixtureEvent {
  type: string;
  scenario: Scenario;
  invocation: Invocation;
  processId: number;
  role?: 'initializer' | 'worker' | 'verifier';
  responseKind?: 'effect' | 'repair' | 'finish';
  sawUncertainRecovery?: boolean;
  [key: string]: unknown;
}

interface RunningHarness {
  child: ChildProcess;
  stderr: string;
  stdout: string;
  spawnError?: Error;
}

const TASK = 'Publish report.csv with exactly one name column and one row.';
const CHILD_FIXTURE = fileURLToPath(
  new URL('../fixtures/lifecycleCrashChild.ts', import.meta.url),
);
const PROCESS_TIMEOUT_MS = 15_000;

let tempRoot: string;
let runDir: string;
let eventsPath: string;
const activeChildren = new Set<RunningHarness>();

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'sherlock-real-crash-'));
  runDir = join(tempRoot, 'run');
  eventsPath = join(tempRoot, 'events.jsonl');
  mkdirSync(runDir);
  initManifest(runDir, TASK, 'local');
  writeArtifact(
    runDir,
    'artifacts/report.csv',
    Buffer.from('name\nAlice\n', 'utf8'),
    { roles: ['requested_output'] },
  );
  writeArtifact(
    runDir,
    'artifacts/evidence.png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    },
  );
});

afterEach(async () => {
  await Promise.all([...activeChildren].map(stopHarness));
  rmSync(tempRoot, { recursive: true, force: true });
});

const processDescribe = process.platform === 'win32' ? describe.skip : describe;

processDescribe('runAgent real process crash recovery', () => {
  it('resumes an accepted contract checkpoint without rerunning initialization', async () => {
    const first = startHarness('contract', 'initial');
    await expectBoundary(first, 'accepted_contract');
    await killHarness(first);

    const acceptedCheckpoint = readCheckpoint();
    expect(acceptedCheckpoint).toMatchObject({
      version: 3,
      phase: 'initializing',
      contract: { outputs: [{ filename: 'report.csv' }] },
    });
    expect(existsSync(join(runDir, 'harness/output-contract.json'))).toBe(false);

    const resumed = startHarness('contract', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome).toMatchObject({
      status: 'verified',
      finalText: 'Published the requested one-row report.',
    });

    const events = readEvents();
    expect(modelEvents(events, 'initializer')).toHaveLength(1);
    expect(modelEvents(events, 'worker')).toHaveLength(1);
    expect(modelEvents(events, 'verifier')).toHaveLength(1);
    expect(readJson(join(runDir, 'harness/output-contract.json'))).toEqual(
      acceptedCheckpoint.contract,
    );
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      finish: {
        summary: 'Published the requested one-row report.',
      },
      outcome,
    });
  }, 20_000);

  it('retries an interrupted model request from the last durable conversation', async () => {
    const first = startHarness('model_in_flight', 'initial');
    await expectBoundary(first, 'model_in_flight');
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'ready_for_model',
      worker: { turnCount: 0 },
    });
    expect(modelEvents(readEvents(), 'worker')).toHaveLength(1);

    const resumed = startHarness('model_in_flight', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    expect(modelEvents(readEvents(), 'worker')).toHaveLength(2);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      budget: { roles: { worker: { turns: 1 } } },
      outcome,
    });
  }, 20_000);

  it('executes exactly once after a crash at the durable pre-tool boundary', async () => {
    const first = startHarness('pre_tool', 'initial');
    await expectBoundary(first, 'pre_tool');
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'executing_tool',
      pendingTurn: {
        effect: 'not_started',
        nextCallIndex: 0,
        calls: [{ id: 'effect-once', name: 'record_effect' }],
      },
    });
    expect(readEvents().filter((event) => event.type === 'tool_effect')).toHaveLength(0);

    const resumed = startHarness('pre_tool', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    expect(readEvents().filter((event) => event.type === 'tool_effect')).toHaveLength(1);
    expect(readCheckpoint()).toMatchObject({ phase: 'terminal', outcome });
  }, 20_000);

  it('never replays an effect killed after the durable uncertain checkpoint', async () => {
    const first = startHarness('uncertain_tool', 'initial');
    await expectBoundary(first, 'uncertain_tool');

    const effect = waitForMessage(first, (message) => message.type === 'tool_effect');
    await sendMessage(first, { type: 'continue' });
    await effect;
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'executing_tool',
      pendingTurn: {
        effect: 'uncertain',
        nextCallIndex: 0,
        calls: [{ id: 'effect-once', name: 'record_effect' }],
      },
    });
    expect(readEvents().filter((event) => event.type === 'tool_effect')).toHaveLength(1);

    const resumed = startHarness('uncertain_tool', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    const events = readEvents();
    expect(events.filter((event) => event.type === 'tool_effect')).toHaveLength(1);
    expect(
      modelEvents(events, 'worker').filter(
        (event) => event.invocation === 'resume',
      ),
    ).toEqual([
      expect.objectContaining({
        responseKind: 'finish',
        sawUncertainRecovery: true,
      }),
    ]);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      finish: {
        summary: 'Published the requested one-row report.',
      },
      outcome,
    });
  }, 20_000);

  it('does not replay a tool whose result was durable before the crash', async () => {
    const first = startHarness('post_tool', 'initial');
    await expectBoundary(first, 'post_tool');
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'ready_for_model',
      worker: { turnCount: 1 },
    });
    expect(JSON.stringify(readCheckpoint())).toContain('effect-once');
    expect(readEvents().filter((event) => event.type === 'tool_effect')).toHaveLength(1);

    const resumed = startHarness('post_tool', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    expect(readEvents().filter((event) => event.type === 'tool_effect')).toHaveLength(1);
    expect(readCheckpoint()).toMatchObject({ phase: 'terminal', outcome });
  }, 20_000);

  it('reconciles a killed tool workspace before terminalizing an already-cancelled resume', async () => {
    const first = startHarness('cancelled_workspace_recovery', 'initial');
    await expectBoundary(first, 'uncertain_tool');

    const effect = waitForMessage(first, (message) => message.type === 'tool_effect');
    await sendMessage(first, { type: 'continue' });
    await effect;
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'executing_tool',
      pendingTurn: { effect: 'uncertain', nextCallIndex: 0 },
    });
    const workspacePath = 'scratch/workspace/killed-command.txt';
    expect(
      readManifest(runDir).artifacts.some(
        (entry) => entry.filename === workspacePath,
      ),
    ).toBe(false);

    const resumed = startHarness('cancelled_workspace_recovery', 'resume');
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('cancelled');
    expect(readManifest(runDir)).toMatchObject({
      finishedAt: expect.any(String),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ filename: workspacePath }),
      ]),
    });
    expect(
      modelEvents(readEvents(), 'worker').filter(
        (event) => event.invocation === 'resume',
      ),
    ).toEqual([]);
  }, 20_000);

  it('durably charges a verifier call before crash, then rebills its read-only retry', async () => {
    const first = startHarness('verifying', 'initial');
    await expectBoundary(first, 'verifier_result_recorded');
    await killHarness(first);

    const verifyingCheckpoint = readCheckpoint();
    expect(verifyingCheckpoint).toMatchObject({
      phase: 'verifying',
      pendingVerifier: { recovery: 'restart_read_only' },
      pendingFinish: { call: { id: 'finish-report', name: 'finish' } },
      budget: {
        toolCalls: 3,
        roles: { verifier: { turns: 1 } },
      },
    });
    const beforeResume = readEvents();
    expect(modelEvents(beforeResume, 'worker')).toHaveLength(1);
    expect(modelEvents(beforeResume, 'verifier')).toHaveLength(1);

    const resumed = startHarness('verifying', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    const events = readEvents();
    expect(modelEvents(events, 'initializer')).toHaveLength(1);
    expect(modelEvents(events, 'worker')).toEqual([
      expect.objectContaining({ responseKind: 'finish', invocation: 'initial' }),
    ]);
    expect(modelEvents(events, 'verifier')).toHaveLength(2);
    expect(
      modelEvents(events, 'verifier').map((event) => event.invocation),
    ).toEqual(['initial', 'resume']);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      finish: {
        summary: 'Published the requested one-row report.',
      },
      budget: {
        toolCalls: 4,
        roles: { verifier: { turns: 2 } },
      },
      outcome,
    });
  }, 20_000);

  it('durably charges an accepted worker response before a crash can retry it', async () => {
    const first = startHarness('worker_accounting', 'initial');
    await expectBoundary(first, 'worker_accounting_recorded');
    await killHarness(first);

    expect(readCheckpoint()).toMatchObject({
      phase: 'ready_for_model',
      worker: { turnCount: 1 },
      budget: { roles: { worker: { turns: 1 } } },
    });
    expect(modelEvents(readEvents(), 'worker')).toHaveLength(1);

    const resumed = startHarness('worker_accounting', 'resume');
    expect(resumed.child.pid).not.toBe(first.child.pid);
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    expect(modelEvents(readEvents(), 'worker')).toHaveLength(2);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      budget: { roles: { worker: { turns: 2 } } },
      outcome,
    });
  }, 20_000);

  it('resumes from durable deterministic-check feedback without losing or duplicating it', async () => {
    writeArtifact(
      runDir,
      'artifacts/report.csv',
      Buffer.from('name\nAlice\nBob\n', 'utf8'),
      { roles: ['requested_output'] },
    );
    const first = startHarness('deterministic_feedback', 'initial');
    await expectBoundary(first, 'deterministic_feedback_recorded');
    await killHarness(first);

    expect(JSON.stringify(readCheckpoint())).toContain(
      'deterministic_finish_checks',
    );
    const resumed = startHarness('deterministic_feedback', 'resume');
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    const workerEvents = modelEvents(readEvents(), 'worker');
    expect(workerEvents.map((event) => event.responseKind)).toEqual([
      'finish',
      'repair',
      'finish',
    ]);
    expect(workerEvents.filter((event) => event.sawDeterministicFeedback)).toHaveLength(2);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      progress: { completionCheckFailures: 1 },
      outcome,
    });
  }, 20_000);

  it('resumes from durable verifier correction feedback in the same worker conversation', async () => {
    const first = startHarness('verifier_correction', 'initial');
    await expectBoundary(first, 'verifier_correction_recorded');
    await killHarness(first);

    expect(JSON.stringify(readCheckpoint())).toContain('fixture_correction');
    const resumed = startHarness('verifier_correction', 'resume');
    const outcome = await expectOutcome(resumed);
    expect(outcome.status).toBe('verified');

    const events = readEvents();
    expect(modelEvents(events, 'worker')).toEqual([
      expect.objectContaining({ responseKind: 'finish', invocation: 'initial' }),
      expect.objectContaining({
        responseKind: 'finish',
        invocation: 'resume',
        sawVerifierCorrection: true,
      }),
    ]);
    expect(modelEvents(events, 'verifier')).toHaveLength(2);
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      progress: { verifierCycles: 2 },
      outcome,
    });
  }, 20_000);
});

function startHarness(
  scenario: Scenario,
  invocation: Invocation,
): RunningHarness {
  const child = fork(
    CHILD_FIXTURE,
    [scenario, invocation, runDir, eventsPath],
    {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      silent: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  );
  const running: RunningHarness = { child, stderr: '', stdout: '' };
  child.stderr?.on('data', (chunk: Buffer | string) => {
    running.stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    running.stdout += chunk.toString();
  });
  child.on('error', (error) => {
    running.spawnError = error;
  });
  activeChildren.add(running);
  return running;
}

async function expectBoundary(
  running: RunningHarness,
  boundary: string,
): Promise<HarnessMessage> {
  return waitForMessage(
    running,
    (message) =>
      message.type === 'boundary' && message.boundary === boundary,
  );
}

async function expectOutcome(
  running: RunningHarness,
): Promise<NonNullable<HarnessMessage['outcome']>> {
  const message = await waitForMessage(
    running,
    (candidate) => candidate.type === 'outcome',
  );
  await waitForExit(running);
  activeChildren.delete(running);
  expect(existsSync(join(runDir, 'harness/run.lock'))).toBe(false);
  expect(
    readJsonLines(join(runDir, 'transcript.jsonl')).filter(
      (event) => event.type === 'v3_run_terminal',
    ),
  ).toHaveLength(1);
  if (message.outcome === undefined) {
    throw new Error(`fixture sent outcome message without an outcome${diagnostic(running)}`);
  }
  return message.outcome;
}

function waitForMessage(
  running: RunningHarness,
  predicate: (message: HarnessMessage) => boolean,
): Promise<HarnessMessage> {
  return new Promise<HarnessMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for fixture IPC${diagnostic(running)}`));
    }, PROCESS_TIMEOUT_MS);
    const onMessage = (candidate: unknown): void => {
      if (!isHarnessMessage(candidate)) return;
      if (candidate.type === 'fixture_error') {
        cleanup();
        reject(new Error(`fixture failed: ${candidate.message ?? 'unknown error'}${diagnostic(running)}`));
        return;
      }
      if (predicate(candidate)) {
        cleanup();
        resolve(candidate);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `fixture exited before expected IPC (code=${String(code)}, signal=${String(signal)})` +
            diagnostic(running),
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off('message', onMessage);
      running.child.off('exit', onExit);
    };
    running.child.on('message', onMessage);
    running.child.once('exit', onExit);
  });
}

function sendMessage(
  running: RunningHarness,
  message: HarnessMessage,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    running.child.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function killHarness(running: RunningHarness): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGKILL');
  }
  const exit = await waitForExit(running);
  activeChildren.delete(running);
  expect(exit.signal).toBe('SIGKILL');
}

async function stopHarness(running: RunningHarness): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGKILL');
  }
  try {
    await waitForExit(running, 3_000);
  } catch {
    // Best effort in afterEach; the explicit assertions retain diagnostics.
  }
  activeChildren.delete(running);
}

function waitForExit(
  running: RunningHarness,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return Promise.resolve({
      code: running.child.exitCode,
      signal: running.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for fixture exit${diagnostic(running)}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off('exit', onExit);
    };
    running.child.once('exit', onExit);
  });
}

function readEvents(): FixtureEvent[] {
  if (!existsSync(eventsPath)) return [];
  return readJsonLines(eventsPath) as FixtureEvent[];
}

function modelEvents(
  events: readonly FixtureEvent[],
  role: NonNullable<FixtureEvent['role']>,
): FixtureEvent[] {
  return events.filter(
    (event) => event.type === 'model_call' && event.role === role,
  );
}

function readCheckpoint(): Record<string, unknown> {
  return readJson(join(runDir, 'harness/checkpoint.json'));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function diagnostic(running: RunningHarness): string {
  const details = [
    running.spawnError === undefined
      ? ''
      : `spawn error: ${running.spawnError.message}`,
    running.stderr.trim() === '' ? '' : `stderr:\n${running.stderr.trim()}`,
    running.stdout.trim() === '' ? '' : `stdout:\n${running.stdout.trim()}`,
  ].filter((value) => value !== '');
  return details.length === 0 ? '' : `\n${details.join('\n')}`;
}

function isHarnessMessage(value: unknown): value is HarnessMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}
