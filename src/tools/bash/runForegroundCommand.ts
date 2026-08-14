import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface ForegroundCommandOptions {
  /** Path to the shell binary, e.g. '/bin/bash'. Invoked as `${shellPath} -c command`. */
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
 * Decode captured bytes, dropping a trailing INCOMPLETE UTF-8 sequence.
 *
 * The byte ceiling cuts at an exact byte offset, which can land in the middle
 * of a multibyte character. Decoding that partial sequence directly would
 * yield U+FFFD, and U+FFFD re-encodes to THREE bytes — so a result truncated
 * to exactly N bytes could come back as N+1 and break the very ceiling the
 * truncation exists to enforce.
 *
 * This trims at the concatenated boundary rather than per chunk on purpose: a
 * character can straddle two chunks, so only the final assembled buffer knows
 * where the last complete character actually ends. At most three bytes are
 * dropped, and only from output already declared over its limit.
 */
function decodeRetainedBytes(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  // Walk back over continuation bytes (10xxxxxx) to the sequence's lead byte.
  let cut = buffer.length;
  let continuationBytes = 0;
  while (cut > 0 && (buffer[cut - 1]! & 0b1100_0000) === 0b1000_0000 && continuationBytes < 3) {
    cut -= 1;
    continuationBytes += 1;
  }
  if (cut === 0 || continuationBytes === 0) return buffer.toString('utf8');
  const lead = buffer[cut - 1]!;
  // How many bytes the lead byte says its sequence needs, in total.
  const expected = lead >= 0b1111_0000 ? 4 : lead >= 0b1110_0000 ? 3 : lead >= 0b1100_0000 ? 2 : 1;
  // Complete already (or not a lead byte at all — invalid input we leave
  // alone rather than silently reshaping).
  if (expected === 1 || expected <= continuationBytes) return buffer.toString('utf8');
  return buffer.subarray(0, cut - 1).toString('utf8');
}

/**
 * Bounds ONE foreground process tree: spawn it, capture its output, and
 * guarantee it (and anything it forked) is gone by the time this resolves —
 * whether it finished on its own, ran past `timeoutMs`, wrote past
 * `maxOutputBytes`, or was cancelled via `abortSignal`. This function knows
 * nothing about tools, transcripts, or models; it only manages one process
 * group's lifecycle.
 *
 * The shell is invoked as exactly `[shellPath, '-c', command]` — never a
 * login shell, never sourcing profiles. `stdio` closes stdin immediately (a
 * command reading stdin sees EOF rather than hanging) and `detached: true`
 * makes the child the leader of a fresh process group, so the whole tree —
 * including background jobs the command itself forks — can be reached with
 * one signal to `-pid`.
 *
 * Every path that can end the call (normal exit, spawn `error`, timeout,
 * abort, output overflow) funnels through one `settleOnce` guard so the
 * returned promise settles exactly once. The only path that *rejects*
 * instead of resolving is a spawn failure that never produced a process at
 * all (Node reports this as an `error` event with `child.pid` still
 * `undefined`) — see the comment on that branch below.
 */
export function runForegroundCommand(
  options: ForegroundCommandOptions,
): Promise<ForegroundCommandResult> {
  const { shellPath, command, cwd, env, timeoutMs, maxOutputBytes, abortSignal } = options;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();

  return new Promise<ForegroundCommandResult>((resolve, reject) => {
    // An already-aborted signal must never spawn a process at all.
    if (abortSignal?.aborted === true) {
      resolve({
        status: 'cancelled',
        exitCode: null,
        terminationSignal: null,
        durationMs: now() - startedAt,
        stdout: '',
        stderr: '',
      });
      return;
    }

    const child = spawn(shellPath, ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let settled = false;
    // Set by whichever of timeout/abort/overflow fires first, so the exit
    // that our own kill signal causes is reported with the right reason
    // instead of the generic 'exited'. Left null for a process that simply
    // ran to completion (or died on its own, e.g. a self-inflicted signal).
    let pendingStatus: ForegroundCommandStatus | null = null;
    let terminationTriggered = false;

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
      if (remaining <= 0) return;
      // Byte ceiling, enforced on the raw Buffer length — never on decoded
      // string length, which would undercount multibyte UTF-8 text.
      const toKeep = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      target.push(toKeep);
      totalBytes += toKeep.length;
      if (toKeep.length < chunk.length) {
        triggerTermination('output_limit_exceeded');
      }
    }

    child.stdout.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk));
    child.stdout.on('end', () => {
      stdoutEnded = true;
    });
    child.stderr.on('end', () => {
      stderrEnded = true;
    });

    function settleOnce(action: () => void): void {
      if (settled) return;
      settled = true;
      clearAllTimers();
      detachAbort();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      action();
    }

    function finalize(
      status: ForegroundCommandStatus,
      exitCode: number | null,
      terminationSignal: string | null,
    ): void {
      settleOnce(() => {
        resolve({
          status,
          exitCode,
          terminationSignal,
          durationMs: now() - startedAt,
          stdout: decodeRetainedBytes(stdoutChunks),
          stderr: decodeRetainedBytes(stderrChunks),
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
        child.stdout.off('end', onStreamsEnded);
        child.stderr.off('end', onStreamsEnded);
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
      child.stdout.on('end', onStreamsEnded);
      child.stderr.on('end', onStreamsEnded);
      drainDeadlineTimer = setTimeout(finishExit, DRAIN_DEADLINE_MS);
    });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      triggerTermination('timed_out');
    }, timeoutMs);

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
