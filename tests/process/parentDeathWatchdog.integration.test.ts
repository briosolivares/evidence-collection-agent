import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Scenario = 'bash' | 'browser';

interface RunningFixture {
  child: ChildProcess;
  stderr: string;
  stdout: string;
}

interface ContainedProcesses {
  processGroupId?: number;
  descendantPid?: number;
}

const FIXTURE = fileURLToPath(
  new URL('../fixtures/processCrashContainmentChild.ts', import.meta.url),
);
const READY_TIMEOUT_MS = 10_000;
const PROCESS_DEATH_TIMEOUT_MS = 5_000;
const MARKER_DELAY_MS = 700;

let workDir: string;
const activeFixtures = new Set<RunningFixture>();
const activeContainedProcesses = new Set<ContainedProcesses>();

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sherlock-parent-death-watchdog-'));
});

afterEach(async () => {
  await Promise.all([...activeFixtures].map(stopFixture));
  for (const processes of activeContainedProcesses) {
    hardKillContainedProcesses(processes);
  }
  activeContainedProcesses.clear();
  rmSync(workDir, { recursive: true, force: true });
});

const processDescribe = process.platform === 'win32' ? describe.skip : describe;

processDescribe('parent-death process containment', () => {
  it('kills a SIGTERM-resistant Bash process group when the harness is SIGKILLed', async () => {
    await assertCrashContainment('bash');
  }, 20_000);

  it('kills a CPU-looping browser child and its descendant when the harness is SIGKILLed', async () => {
    await assertCrashContainment('browser');
  }, 20_000);
});

async function assertCrashContainment(scenario: Scenario): Promise<void> {
  const fixture = startFixture(scenario);
  const containedProcesses: ContainedProcesses = {};
  activeContainedProcesses.add(containedProcesses);
  const targetPidPath = join(workDir, 'target.pid');
  const descendantPidPath = join(workDir, 'descendant.pid');
  const markerPath = join(workDir, 'delayed-marker.txt');

  try {
    // Creation and contents are not one filesystem event: under full-suite
    // load the polling process can observe an empty file between open(2) and
    // the fixture's write. Wait for complete, parseable PIDs instead of only
    // directory-entry visibility.
    await waitFor(() => pidFileIsReady(targetPidPath) && pidFileIsReady(descendantPidPath));
    const targetPid = readPid(targetPidPath);
    const descendantPid = readPid(descendantPidPath);
    containedProcesses.processGroupId = targetPid;
    containedProcesses.descendantPid = descendantPid;
    expect(isProcessAlive(targetPid)).toBe(true);
    expect(isProcessAlive(descendantPid)).toBe(true);

    fixture.child.kill('SIGKILL');
    const exit = await waitForExit(fixture);
    activeFixtures.delete(fixture);
    expect(exit.signal).toBe('SIGKILL');

    // Crash recovery is allowed to start as soon as the dead harness releases
    // its run lock. Write the replacement effect immediately; the old group
    // must never survive long enough to overwrite it during a termination
    // grace window.
    writeFileSync(markerPath, 'replacement', 'utf8');

    await waitFor(
      () => !isProcessAlive(targetPid) && !isProcessAlive(descendantPid),
      PROCESS_DEATH_TIMEOUT_MS,
    );
    await wait(MARKER_DELAY_MS);

    expect(isProcessAlive(targetPid)).toBe(false);
    expect(isProcessAlive(descendantPid)).toBe(false);
    expect(readFileSync(markerPath, 'utf8')).toBe('replacement');
    expect(existsSync(join(workDir, 'fixture-error.txt'))).toBe(false);
  } finally {
    await stopFixture(fixture);
    hardKillContainedProcesses(containedProcesses);
    activeContainedProcesses.delete(containedProcesses);
  }
}

function startFixture(scenario: Scenario): RunningFixture {
  const child = fork(FIXTURE, [scenario, workDir], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, FORCE_COLOR: '0', NO_COLOR: '1' },
    execArgv: ['--import', 'tsx'],
    silent: true,
  });
  const fixture: RunningFixture = { child, stderr: '', stdout: '' };
  child.stderr?.on('data', (chunk: Buffer | string) => {
    fixture.stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    fixture.stdout += chunk.toString();
  });
  activeFixtures.add(fixture);
  return fixture;
}

function readPid(path: string): number {
  const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`fixture wrote an invalid process id to ${path}`);
  }
  return pid;
}

function pidFileIsReady(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, 'utf8');
    if (!/^\d+$/.test(text)) return false;
    const pid = Number.parseInt(text, 10);
    return Number.isSafeInteger(pid) && pid > 1;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function hardKillContainedProcesses(processes: ContainedProcesses): void {
  const { processGroupId, descendantPid } = processes;
  const targetAlive = processGroupId !== undefined && isProcessAlive(processGroupId);
  const descendantAlive = descendantPid !== undefined && isProcessAlive(descendantPid);

  if (processGroupId !== undefined && (targetAlive || descendantAlive)) {
    try {
      process.kill(-processGroupId, 'SIGKILL');
    } catch {
      // The watchdog may already have removed the complete process group.
    }
  }
  if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch {
      // Best-effort fallback for a descendant that left the original group.
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const exited = [...activeFixtures].find(
      ({ child }) => child.exitCode !== null || child.signalCode !== null,
    );
    if (exited !== undefined) {
      throw new Error(`crash fixture exited before becoming ready${diagnostic(exited)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for crash fixture${diagnostic()}`);
    }
    await wait(20);
  }
}

function waitForExit(
  fixture: RunningFixture,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
    return Promise.resolve({
      code: fixture.child.exitCode,
      signal: fixture.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fixture did not exit after SIGKILL${diagnostic(fixture)}`));
    }, READY_TIMEOUT_MS);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      fixture.child.off('exit', onExit);
    };
    fixture.child.once('exit', onExit);
  });
}

async function stopFixture(fixture: RunningFixture): Promise<void> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill('SIGKILL');
    try {
      await waitForExit(fixture);
    } catch {
      // Best effort test cleanup; the original assertion reports diagnostics.
    }
  }
  activeFixtures.delete(fixture);
}

function diagnostic(fixture?: RunningFixture): string {
  const current = fixture ?? [...activeFixtures][0];
  if (current === undefined) return '';
  return `\nstdout:\n${current.stdout}\nstderr:\n${current.stderr}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
