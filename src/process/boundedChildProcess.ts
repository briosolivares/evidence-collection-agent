import type { ChildProcess } from 'node:child_process';

import { decodeCapturedOutput } from './decodeCapturedOutput.js';
import type { ParentDeathWatchdog, ParentDeathWatchdogError } from './parentDeathWatchdog.js';

/**
 * Per-supervisor timing constants. Each runner keeps its own values — the
 * bash runner's tree gets a longer SIGTERM grace than a browser program's —
 * so these are inputs, never shared defaults.
 */
export interface BoundedChildProcessTimings {
  /** Wall-clock budget for the whole child lifecycle. */
  timeoutMs: number;
  /** Grace between SIGTERM and SIGKILL during active termination. */
  terminateGraceMs: number;
  /**
   * Once the child itself exits, how long a stray descendant still sharing
   * its process group gets to respond to SIGTERM before SIGKILL.
   */
  strayKillDelayMs: number;
  /**
   * After exit, the hard ceiling on waiting for the stdio pipes to report
   * `end`. A descendant that inherited a pipe can hold it open indefinitely,
   * so this is a deadline, never an indefinite wait.
   */
  drainDeadlineMs: number;
  /**
   * Optional hard ceiling on an entire termination sequence: if the child
   * has not exited this long after termination began, SIGKILL again and
   * settle with whatever was captured. Omitted, the supervisor waits for the
   * exit event (SIGKILL cannot be ignored).
   */
  terminationDeadlineMs?: number;
}

export interface BoundedChildProcessOutcomes<TOutcome> {
  timedOut(): TOutcome;
  outputLimitExceeded(): TOutcome;
  aborted(): TOutcome;
  /**
   * Forced outcome recorded when the parent-death watchdog fails. It takes
   * precedence over any ordinary outcome, including a later replacement.
   */
  watchdogFailed(error: ParentDeathWatchdogError): TOutcome;
  /** Ordinary outcome recorded at child exit when none was recorded yet. */
  exitedWithoutOutcome?(code: number | null, signal: NodeJS.Signals | null): TOutcome;
}

export interface BoundedChildProcessOptions<TOutcome> {
  /**
   * The already-spawned child. It must have piped stdout and stderr and be a
   * detached POSIX process-group leader; spawning (and each caller's own
   * spawn-failure policy) stays caller-side.
   */
  child: ChildProcess;
  /** Started watchdog; the supervisor arms nothing but owns failure wiring and the final disarm. */
  watchdog: ParentDeathWatchdog;
  abortSignal?: AbortSignal | undefined;
  /** Aggregate raw-byte ceiling shared by stdout and stderr. */
  maxOutputBytes: number;
  /**
   * Whether a chunk that exactly fills the byte budget terminates the child
   * immediately (bash) or only a chunk that overflows it does, leaving an
   * exactly-full capture to finish on its own (browser programs).
   */
  terminateOnExactFill: boolean;
  timings: BoundedChildProcessTimings;
  outcomes: BoundedChildProcessOutcomes<TOutcome>;
  /**
   * Precedence when an ordinary outcome is already recorded and another
   * arrives. Default: the first outcome wins unconditionally.
   */
  replaceOutcome?(current: TOutcome, next: TOutcome): boolean;
  /** Extra caller cleanup on settle, before the watchdog is disarmed (e.g. destroying a start gate). */
  onCleanup?(): void;
}

export interface BoundedChildProcessCompletion<TOutcome> {
  /** Forced outcome if any, else the ordinary one; undefined for a plain natural exit. */
  outcome: TOutcome | undefined;
  exitCode: number | null;
  terminationSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BoundedChildProcessSupervision<TOutcome> {
  /**
   * Resolves exactly once, after the process group is hard-killed, the
   * streams drained (or their deadline passed), and the watchdog disarmed.
   * It never rejects; callers own mapping outcomes to results or errors.
   */
  readonly completion: Promise<BoundedChildProcessCompletion<TOutcome>>;
  readonly settled: boolean;
  readonly terminationStarted: boolean;
  readonly exitObserved: boolean;
  /** True once any outcome — ordinary or forced — is recorded. */
  readonly hasOutcome: boolean;
  /** Record an outcome (respecting replace policy) and begin SIGTERM→grace→SIGKILL termination. */
  terminate(outcome: TOutcome): void;
  /** Record a forced outcome that beats every ordinary outcome at completion. */
  forceOutcome(outcome: TOutcome): void;
  /**
   * Settle immediately without waiting for exit or stream drain (the child
   * 'error' paths). Optional overrides replace the reported exit fields.
   */
  finishNow(overrides?: {
    exitCode: number | null;
    terminationSignal: NodeJS.Signals | null;
  }): void;
}

/**
 * Bounds ONE already-spawned child process tree: capture its output, and
 * guarantee it (and anything it forked) is gone by the time `completion`
 * resolves — whether it finished on its own, ran past `timeoutMs`, wrote past
 * `maxOutputBytes`, or was cancelled via `abortSignal`. This is the shared
 * skeleton behind the bash and browser-program runners; it knows nothing
 * about shells, IPC protocols, or result shapes. Outcome values are opaque
 * (`TOutcome`, never undefined) so each runner keeps its own status enum and
 * its own error/result-precedence policy via `outcomes`/`replaceOutcome`.
 *
 * Termination invariants preserved from both runners: process-group
 * SIGTERM→grace→SIGKILL; a stray-descendant SIGTERM→SIGKILL sweep after the
 * child exits; a hard stream-drain deadline; a synchronous group SIGKILL on
 * settle before the watchdog is disarmed; and on watchdog failure an
 * immediate synchronous SIGKILL with no soft-kill window during which a
 * harness SIGKILL of this parent could abandon the group.
 */
export function superviseBoundedChildProcess<TOutcome>(
  options: BoundedChildProcessOptions<TOutcome>,
): BoundedChildProcessSupervision<TOutcome> {
  const { child, watchdog, abortSignal, maxOutputBytes, terminateOnExactFill, timings, outcomes } =
    options;
  const stdout = child.stdout!;
  const stderr = child.stderr!;

  let settled = false;
  let terminationStarted = false;
  let exitObserved = false;
  let outcome: TOutcome | undefined;
  let forcedOutcome: TOutcome | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stdoutEnded = false;
  let stderrEnded = false;
  let totalBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  let timeoutTimer: NodeJS.Timeout | undefined;
  let graceKillTimer: NodeJS.Timeout | undefined;
  let strayKillTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let terminationDeadlineTimer: NodeJS.Timeout | undefined;

  let resolveCompletion!: (completion: BoundedChildProcessCompletion<TOutcome>) => void;
  const completion = new Promise<BoundedChildProcessCompletion<TOutcome>>((resolve) => {
    resolveCompletion = resolve;
  });

  const clearTimers = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceKillTimer) clearTimeout(graceKillTimer);
    if (strayKillTimer) clearTimeout(strayKillTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (terminationDeadlineTimer) clearTimeout(terminationDeadlineTimer);
    timeoutTimer = undefined;
    graceKillTimer = undefined;
    strayKillTimer = undefined;
    drainTimer = undefined;
    terminationDeadlineTimer = undefined;
  };

  /** Signals the whole process group. The group may already be gone — that's fine, not an error. */
  const killGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH (group already reaped) or similar — nothing left to clean up.
      // Other signal failures surface through the escalation timers rather
      // than by throwing mid-lifecycle.
    }
  };

  const recordOutcome = (next: TOutcome): void => {
    if (outcome === undefined) {
      outcome = next;
      return;
    }
    if (options.replaceOutcome?.(outcome, next) === true) outcome = next;
  };

  const armTerminationDeadline = (): void => {
    if (timings.terminationDeadlineMs === undefined || terminationDeadlineTimer) return;
    terminationDeadlineTimer = setTimeout(() => {
      terminationDeadlineTimer = undefined;
      killGroup('SIGKILL');
      finish();
    }, timings.terminationDeadlineMs);
  };

  /**
   * Record the reason (per the replace policy) and begin active termination.
   * Idempotent on the kill side: the first caller starts SIGTERM→grace→
   * SIGKILL; actually settling still waits for the resulting exit event,
   * which is what lets a natural exit and a timeout/abort race safely.
   */
  const terminate = (next: TOutcome): void => {
    if (settled) return;
    recordOutcome(next);
    if (terminationStarted) return;
    terminationStarted = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    killGroup('SIGTERM');
    graceKillTimer = setTimeout(() => {
      graceKillTimer = undefined;
      killGroup('SIGKILL');
    }, timings.terminateGraceMs);
    armTerminationDeadline();
  };

  const onAbort = (): void => terminate(outcomes.aborted());
  const detachAbort = (): void => {
    abortSignal?.removeEventListener('abort', onAbort);
  };

  const detachWatchdogFailure = watchdog.onFailure((error) => {
    if (settled) return;
    // The independent watcher is already gone. There can be no soft-kill
    // interval during which a subsequent harness SIGKILL would abandon this
    // group, so fail closed with an immediate synchronous hard signal and
    // force the infrastructure outcome over any ordinary one.
    forcedOutcome = outcomes.watchdogFailed(error);
    terminationStarted = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (graceKillTimer) {
      clearTimeout(graceKillTimer);
      graceKillTimer = undefined;
    }
    killGroup('SIGKILL');
    armTerminationDeadline();
  });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    detachAbort();
    detachWatchdogFailure();
    // This synchronous hard kill closes the target before the watchdog is
    // disarmed. It also covers SIGTERM-resistant background descendants on
    // ordinary completion.
    killGroup('SIGKILL');
    options.onCleanup?.();
    stdout.removeAllListeners();
    stderr.removeAllListeners();
    child.removeAllListeners();
    const result: BoundedChildProcessCompletion<TOutcome> = {
      outcome: forcedOutcome ?? outcome,
      exitCode,
      terminationSignal: exitSignal,
      stdout: decodeCapturedOutput(stdoutChunks),
      stderr: decodeCapturedOutput(stderrChunks),
    };
    void watchdog.disarm().then(
      () => resolveCompletion(result),
      () => resolveCompletion(result),
    );
  };

  const maybeFinishAfterExit = (): void => {
    if (!exitObserved) return;
    if (stdoutEnded && stderrEnded) {
      finish();
      return;
    }
    if (!drainTimer) drainTimer = setTimeout(finish, timings.drainDeadlineMs);
  };

  const appendOutput = (target: Buffer[], chunk: Buffer | string): void => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxOutputBytes - totalBytes;
    if (remaining <= 0) {
      terminate(outcomes.outputLimitExceeded());
      return;
    }
    // Byte ceiling, enforced on the raw Buffer length — never on decoded
    // string length, which would undercount multibyte UTF-8 text.
    const kept = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
    target.push(kept);
    totalBytes += kept.length;
    const capReached = terminateOnExactFill
      ? totalBytes >= maxOutputBytes
      : bytes.length > kept.length;
    if (capReached) terminate(outcomes.outputLimitExceeded());
  };

  stdout.on('data', (chunk: Buffer) => appendOutput(stdoutChunks, chunk));
  stderr.on('data', (chunk: Buffer) => appendOutput(stderrChunks, chunk));
  stdout.once('end', () => {
    stdoutEnded = true;
    maybeFinishAfterExit();
  });
  stderr.once('end', () => {
    stderrEnded = true;
    maybeFinishAfterExit();
  });

  child.once('exit', (code, signal) => {
    if (settled) return;
    exitObserved = true;
    exitCode = code;
    exitSignal = signal;
    // The active-termination timers are now moot — the child is gone.
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (graceKillTimer) {
      clearTimeout(graceKillTimer);
      graceKillTimer = undefined;
    }
    // The child itself is gone, but it may have started a background
    // descendant that is still alive and still in its process group — it
    // must not outlive this supervision.
    killGroup('SIGTERM');
    strayKillTimer = setTimeout(() => {
      strayKillTimer = undefined;
      killGroup('SIGKILL');
    }, timings.strayKillDelayMs);
    if (outcome === undefined && outcomes.exitedWithoutOutcome) {
      outcome = outcomes.exitedWithoutOutcome(code, signal);
    }
    maybeFinishAfterExit();
  });

  // The timeout bounds the complete child lifecycle, including any caller
  // start handshake: a stalled arm must not extend the caller's budget.
  timeoutTimer = setTimeout(() => {
    timeoutTimer = undefined;
    terminate(outcomes.timedOut());
  }, timings.timeoutMs);

  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  }

  return {
    completion,
    get settled() {
      return settled;
    },
    get terminationStarted() {
      return terminationStarted;
    },
    get exitObserved() {
      return exitObserved;
    },
    get hasOutcome() {
      return outcome !== undefined || forcedOutcome !== undefined;
    },
    terminate,
    forceOutcome: (next) => {
      forcedOutcome = next;
    },
    finishNow: (overrides) => {
      if (overrides) {
        exitCode = overrides.exitCode;
        exitSignal = overrides.terminationSignal;
      }
      finish();
    },
  };
}
