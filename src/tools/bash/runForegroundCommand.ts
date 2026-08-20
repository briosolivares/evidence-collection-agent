import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';

import { superviseBoundedChildProcess } from '../../process/boundedChildProcess.js';
import { ParentDeathWatchdogError } from '../../process/parentDeathWatchdog.js';
import { startAbortAwareParentDeathWatchdog } from '../../process/startAbortAwareParentDeathWatchdog.js';

export interface ForegroundCommandOptions {
  /** Path to the shell binary, e.g. '/bin/bash'. The gated child ultimately
   * replaces itself with `${shellPath} -c command`. */
  shellPath: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Wall-clock budget for the whole process tree before it is terminated. */
  timeoutMs: number;
  /** Combined stdout+stderr raw byte ceiling (see capture behavior below). */
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
  /**
   * Clock used for `durationMs`. Defaults to `performance.now()` (monotonic).
   * Not part of process-lifecycle semantics — exists purely so tests can
   * inject a deterministic clock without faking Node's real timers.
   */
  now?: () => number;
}

export type ForegroundCommandStatus =
  | 'exited'
  | 'timed_out'
  | 'output_limit_exceeded'
  | 'cancelled';

export interface ForegroundCommandResult {
  status: ForegroundCommandStatus;
  exitCode: number | null;
  terminationSignal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Grace period between SIGTERM and SIGKILL when actively terminating the process tree. */
const TERMINATE_GRACE_MS = 2000;

/**
 * After the shell itself has exited, how long we wait for its stdio pipes to
 * report `end` before giving up. A background descendant can inherit the
 * pipe and hold it open indefinitely, so this must be a hard ceiling, not an
 * indefinite wait for the streams to close on their own.
 */
const DRAIN_DEADLINE_MS = 1000;

/**
 * Once the shell exits, how long to give a stray descendant to respond to
 * SIGTERM before escalating to SIGKILL. Kept well inside DRAIN_DEADLINE_MS so
 * the escalation has a chance to take effect before the drain gives up.
 */
const STRAY_KILL_DELAY_MS = 500;

/**
 * The real command is passed as an argument, not interpolated into this
 * bootstrap. The temporary shell blocks on fd 3 until the independent
 * parent-death watcher has acknowledged the process group, then replaces
 * itself with the exact requested `${shellPath} -c command` invocation.
 */
const START_GATE_SCRIPT = [
  'if ! IFS= read -r __sherlock_process_start <&3; then exit 125; fi',
  'exec 3<&-',
  'unset __sherlock_process_start',
  'exec "$0" -c "$1"',
].join('\n');

/**
 * This runner resolves with a status for every real command result and
 * *rejects* only for infrastructure failures (watchdog loss, an unusable
 * start gate, a shell that never spawned at all) — the completion outcome
 * keeps the two apart.
 */
type ForegroundOutcome =
  | { kind: 'status'; status: ForegroundCommandStatus }
  | { kind: 'reject'; error: unknown };

const status = (value: ForegroundCommandStatus): ForegroundOutcome => ({
  kind: 'status',
  status: value,
});
const rejection = (error: unknown): ForegroundOutcome => ({ kind: 'reject', error });

/**
 * Bounds ONE foreground process tree: spawn it, capture its output, and
 * guarantee it (and anything it forked) is gone by the time this resolves —
 * whether it finished on its own, ran past `timeoutMs`, wrote past
 * `maxOutputBytes`, or was cancelled via `abortSignal`. This function knows
 * nothing about tools, transcripts, or models; it only manages one process
 * group's lifecycle, delegating the shared machine (byte-capped capture,
 * SIGTERM→grace→SIGKILL, stray-kill, stream-drain deadline, settle-once,
 * watchdog wiring) to `superviseBoundedChildProcess`.
 *
 * A tiny shell gate waits until the independent parent-death watchdog is
 * armed, then `exec`s exactly `[shellPath, '-c', command]` — never a login
 * shell, never sourcing profiles. `stdio` closes stdin immediately (a command
 * reading stdin sees EOF rather than hanging) and `detached: true` makes the
 * child the leader of a fresh process group, so the whole tree — including
 * background jobs the command itself forks — can be reached with one signal
 * to `-pid`.
 *
 * The only path that *rejects* with a non-infrastructure error is a spawn
 * failure that never produced a process at all (Node reports this as an
 * `error` event with `child.pid` still `undefined`) — there is no command
 * result of any kind to report in that case.
 */
export async function runForegroundCommand(
  options: ForegroundCommandOptions,
): Promise<ForegroundCommandResult> {
  const { shellPath, command, cwd, env, timeoutMs, maxOutputBytes, abortSignal } = options;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();

  const watchdogStart = await startAbortAwareParentDeathWatchdog(abortSignal);
  if (watchdogStart.kind === 'start_failed') throw watchdogStart.error;
  // Cancellation before or during watchdog startup must never spawn a command.
  if (watchdogStart.kind === 'cancelled') {
    return {
      status: 'cancelled',
      exitCode: null,
      terminationSignal: null,
      durationMs: now() - startedAt,
      stdout: '',
      stderr: '',
    };
  }
  const watchdog = watchdogStart.watchdog;

  let child: ChildProcess;
  try {
    child = spawn(shellPath, ['-c', START_GATE_SCRIPT, shellPath, command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    await watchdog.disarm();
    throw error;
  }

  const startGate = child.stdio[3] as Writable | null;

  const supervision = superviseBoundedChildProcess<ForegroundOutcome>({
    child,
    watchdog,
    abortSignal,
    maxOutputBytes,
    // A chunk that exactly fills the remaining budget needs no truncation but
    // still means the ceiling is fully spent — terminate right away rather
    // than leaving the output-limit kill path to the next chunk.
    terminateOnExactFill: true,
    timings: {
      timeoutMs,
      terminateGraceMs: TERMINATE_GRACE_MS,
      strayKillDelayMs: STRAY_KILL_DELAY_MS,
      drainDeadlineMs: DRAIN_DEADLINE_MS,
    },
    outcomes: {
      timedOut: () => status('timed_out'),
      outputLimitExceeded: () => status('output_limit_exceeded'),
      aborted: () => status('cancelled'),
      watchdogFailed: rejection,
    },
    onCleanup: () => startGate?.destroy(),
  });

  child.once('error', (err) => {
    if (child.pid === undefined) {
      // The process was never actually spawned (e.g. shellPath does not
      // exist) — there is no command result of any kind to report, so
      // this rejects instead of resolving through the normal result path.
      supervision.forceOutcome(rejection(err));
      supervision.finishNow();
      return;
    }
    // A process did exist, so an 'error' here (e.g. an async failure
    // delivering a signal) still leaves us with a real, if partial,
    // result — resolve with whatever was captured rather than throwing it away.
    supervision.finishNow({ exitCode: null, terminationSignal: null });
  });

  if (startGate === null) {
    supervision.forceOutcome(
      rejection(new ParentDeathWatchdogError('foreground command start gate was unavailable')),
    );
    supervision.terminate(status('cancelled'));
  } else {
    void watchdog.arm(child.pid ?? -1).then(
      () => {
        if (supervision.settled || supervision.terminationStarted) {
          startGate.destroy();
          return;
        }
        startGate.end('start\n');
      },
      (error: unknown) => {
        supervision.forceOutcome(
          rejection(
            error instanceof ParentDeathWatchdogError
              ? error
              : new ParentDeathWatchdogError(
                  'parent-death watchdog failed while arming the command',
                ),
          ),
        );
        startGate.destroy();
        supervision.terminate(status('cancelled'));
      },
    );
  }

  const completion = await supervision.completion;
  if (completion.outcome?.kind === 'reject') throw completion.outcome.error;
  return {
    status: completion.outcome?.status ?? 'exited',
    exitCode: completion.exitCode,
    terminationSignal: completion.terminationSignal,
    durationMs: now() - startedAt,
    stdout: completion.stdout,
    stderr: completion.stderr,
  };
}
