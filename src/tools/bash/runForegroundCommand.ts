import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';

import { decodeCapturedOutput } from '../../process/decodeCapturedOutput.js';
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
 * Bounds ONE foreground process tree: spawn it, capture its output, and
 * guarantee it (and anything it forked) is gone by the time this resolves —
 * whether it finished on its own, ran past `timeoutMs`, wrote past
 * `maxOutputBytes`, or was cancelled via `abortSignal`. This function knows
 * nothing about tools, transcripts, or models; it only manages one process
 * group's lifecycle.
 *
 * A tiny shell gate waits until the independent parent-death watchdog is
 * armed, then `exec`s exactly `[shellPath, '-c', command]` — never a login
 * shell, never sourcing profiles. `stdio` closes stdin immediately (a command
 * reading stdin sees EOF rather than hanging) and `detached: true` makes the
 * child the leader of a fresh process group, so the whole tree — including
 * background jobs the command itself forks — can be reached with one signal
 * to `-pid`.
 *
 * Every path that can end the call (normal exit, spawn `error`, timeout,
 * abort, output overflow) funnels through one `settleOnce` guard so the
 * returned promise settles exactly once. The only path that *rejects*
 * instead of resolving is a spawn failure that never produced a process at
 * all (Node reports this as an `error` event with `child.pid` still
 * `undefined`) — see the comment on that branch below.
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

  return new Promise<ForegroundCommandResult>((resolve, reject) => {
    const startGate = child.stdio[3] as Writable | null;
    const stdout = child.stdout!;
    const stderr = child.stderr!;

    let settled = false;
    // Set by whichever of timeout/abort/overflow fires first, so the exit
    // that our own kill signal causes is reported with the right reason
    // instead of the generic 'exited'. Left null for a process that simply
    // ran to completion (or died on its own, e.g. a self-inflicted signal).
    let pendingStatus: ForegroundCommandStatus | null = null;
    let terminationTriggered = false;
    let infrastructureError: ParentDeathWatchdogError | null = null;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;

    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceKillTimer: NodeJS.Timeout | null = null;
    let strayKillTimer: NodeJS.Timeout | null = null;
    let drainDeadlineTimer: NodeJS.Timeout | null = null;

    const clearAllTimers = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (graceKillTimer !== null) clearTimeout(graceKillTimer);
      if (strayKillTimer !== null) clearTimeout(strayKillTimer);
      if (drainDeadlineTimer !== null) clearTimeout(drainDeadlineTimer);
      timeoutTimer = null;
      graceKillTimer = null;
      strayKillTimer = null;
      drainDeadlineTimer = null;
    };

    const onAbort = (): void => triggerTermination('cancelled');
    const detachAbort = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const detachWatchdogFailure = watchdog.onFailure((error) => {
      if (settled) return;
      infrastructureError = error;
      pendingStatus = 'cancelled';
      terminationTriggered = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (graceKillTimer !== null) {
        clearTimeout(graceKillTimer);
        graceKillTimer = null;
      }
      // The independent watcher is already gone. There can be no soft-kill
      // interval during which a subsequent harness SIGKILL would abandon this
      // group, so fail closed with an immediate synchronous hard signal.
      killGroup('SIGKILL');
    });

    /** Signals the whole process group. The group may already be gone — that's fine, not an error. */
    function killGroup(signal: NodeJS.Signals): void {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // ESRCH (group already reaped) or similar — nothing left to clean up.
      }
    }

    /**
     * Idempotent: the first caller (timeout, abort, or output overflow) wins
     * and records the reason; later callers are no-ops. Actually resolving
     * the promise still waits for the resulting `exit` event (below), which
     * is what lets a natural exit and a timeout/abort race safely — whichever
     * reaches `settleOnce` first is the only one that matters.
     */
    function triggerTermination(status: ForegroundCommandStatus): void {
      if (settled || terminationTriggered) return;
      terminationTriggered = true;
      pendingStatus = status;
      killGroup('SIGTERM');
      graceKillTimer = setTimeout(() => {
        graceKillTimer = null;
        killGroup('SIGKILL');
      }, TERMINATE_GRACE_MS);
    }

    function appendChunk(target: Buffer[], chunk: Buffer): void {
      if (settled) return;
      const remaining = maxOutputBytes - totalBytes;
      if (remaining <= 0) {
        // Already at or over budget from an earlier chunk that exactly
        // filled it (see below) — triggerTermination is idempotent, so this
        // just guarantees the kill path fires even if that earlier chunk's
        // own check somehow didn't.
        triggerTermination('output_limit_exceeded');
        return;
      }
      // Byte ceiling, enforced on the raw Buffer length — never on decoded
      // string length, which would undercount multibyte UTF-8 text.
      const toKeep = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      target.push(toKeep);
      totalBytes += toKeep.length;
      // Checked against the running total, not `toKeep.length < chunk.length`:
      // a chunk that exactly fills the remaining budget needs no truncation
      // (toKeep === chunk) but still means the ceiling is now fully spent —
      // the old per-chunk-truncation check missed exactly that boundary and
      // left the output-limit kill path unreachable from it.
      if (totalBytes >= maxOutputBytes) {
        triggerTermination('output_limit_exceeded');
      }
    }

    stdout.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk));
    stderr.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk));
    stdout.on('end', () => {
      stdoutEnded = true;
    });
    stderr.on('end', () => {
      stderrEnded = true;
    });

    function settleOnce(action: () => void): void {
      if (settled) return;
      settled = true;
      clearAllTimers();
      detachAbort();
      detachWatchdogFailure();
      // This synchronous hard kill closes the target before the watchdog is
      // disarmed. It also covers SIGTERM-resistant background descendants on
      // ordinary completion.
      killGroup('SIGKILL');
      startGate?.destroy();
      stdout.removeAllListeners();
      stderr.removeAllListeners();
      void watchdog.disarm().then(action, action);
    }

    function finalize(
      status: ForegroundCommandStatus,
      exitCode: number | null,
      terminationSignal: string | null,
    ): void {
      settleOnce(() => {
        if (infrastructureError !== null) {
          reject(infrastructureError);
          return;
        }
        resolve({
          status,
          exitCode,
          terminationSignal,
          durationMs: now() - startedAt,
          stdout: decodeCapturedOutput(stdoutChunks),
          stderr: decodeCapturedOutput(stderrChunks),
        });
      });
    }

    child.once('error', (err) => {
      if (child.pid === undefined) {
        // The process was never actually spawned (e.g. shellPath does not
        // exist) — there is no command result of any kind to report, so
        // this rejects instead of resolving through the normal result path.
        settleOnce(() => reject(err));
        return;
      }
      // A process did exist, so an 'error' here (e.g. an async failure
      // delivering a signal) still leaves us with a real, if partial,
      // result — resolve with whatever was captured rather than throwing it away.
      finalize(pendingStatus ?? 'exited', null, null);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      // The active-termination grace timer is now moot — the process is gone.
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (graceKillTimer !== null) {
        clearTimeout(graceKillTimer);
        graceKillTimer = null;
      }

      // The shell itself is gone, but it may have started a background
      // descendant that is still alive and still in its process group — it
      // must not outlive this call.
      killGroup('SIGTERM');
      strayKillTimer = setTimeout(() => {
        strayKillTimer = null;
        killGroup('SIGKILL');
      }, STRAY_KILL_DELAY_MS);

      const finishExit = (): void => {
        stdout.off('end', onStreamsEnded);
        stderr.off('end', onStreamsEnded);
        finalize(pendingStatus ?? 'exited', code, signal);
      };

      const onStreamsEnded = (): void => {
        if (stdoutEnded && stderrEnded) finishExit();
      };

      if (stdoutEnded && stderrEnded) {
        finishExit();
        return;
      }
      // A descendant that inherited these pipes can hold them open
      // indefinitely, so this drain never waits past a hard deadline.
      stdout.on('end', onStreamsEnded);
      stderr.on('end', onStreamsEnded);
      drainDeadlineTimer = setTimeout(finishExit, DRAIN_DEADLINE_MS);
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }

    // timeoutMs bounds the complete child lifecycle, including the gated arm
    // handshake. The command still cannot execute until arm() acknowledges
    // below, but a stalled supervisor must not extend the caller's budget.
    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      triggerTermination('timed_out');
    }, timeoutMs);

    if (startGate === null) {
      infrastructureError = new ParentDeathWatchdogError(
        'foreground command start gate was unavailable',
      );
      triggerTermination('cancelled');
      return;
    }

    void watchdog.arm(child.pid ?? -1).then(
      () => {
        if (settled || terminationTriggered) {
          startGate.destroy();
          return;
        }
        startGate.end('start\n');
      },
      (error: unknown) => {
        infrastructureError =
          error instanceof ParentDeathWatchdogError
            ? error
            : new ParentDeathWatchdogError('parent-death watchdog failed while arming the command');
        startGate.destroy();
        triggerTermination('cancelled');
      },
    );
  });
}
