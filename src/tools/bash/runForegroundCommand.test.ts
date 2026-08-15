import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as parentDeathWatchdogModule from '../../process/parentDeathWatchdog.js';
import { runForegroundCommand } from './runForegroundCommand.js';

const SHELL = '/bin/bash';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await wait(10);
  }
}

function createControlledWatchdog(
  options: { armNeverSettles?: boolean } = {},
): {
  watchdog: parentDeathWatchdogModule.ParentDeathWatchdog;
  fail(): void;
  processGroupId(): number;
} {
  let failureListener:
    | ((error: parentDeathWatchdogModule.ParentDeathWatchdogError) => void)
    | undefined;
  let armedProcessGroupId: number | undefined;

  return {
    watchdog: {
      arm: (processGroupId) => {
        armedProcessGroupId = processGroupId;
        return options.armNeverSettles === true
          ? new Promise<void>(() => undefined)
          : Promise.resolve();
      },
      disarm: async () => undefined,
      onFailure: (listener) => {
        failureListener = listener;
        return () => {
          if (failureListener === listener) failureListener = undefined;
        };
      },
    },
    fail: () => {
      if (failureListener === undefined) {
        throw new Error('watchdog failure listener was not installed');
      }
      failureListener(
        new parentDeathWatchdogModule.ParentDeathWatchdogError(
          'parent-death watchdog stopped while its target was active',
        ),
      );
    },
    processGroupId: () => {
      if (armedProcessGroupId === undefined) {
        throw new Error('watchdog was not armed');
      }
      return armedProcessGroupId;
    },
  };
}

// A generous default: real child processes are fast, but CI machines are
// not, so budgets stay comfortably above what any of these commands need.
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'run-foreground-command-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

describe('runForegroundCommand', () => {
  it('captures stdout and stderr separately, without interleaving them into one buffer', async () => {
    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: `printf 'A'; printf 'B' 1>&2; printf 'C'; printf 'D' 1>&2`,
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    expect(result.stdout).toBe('AC');
    expect(result.stderr).toBe('BD');
  });

  it('reports status "exited" with exit code 0 on success', async () => {
    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: 'exit 0',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.terminationSignal).toBeNull();
  });

  it('reports status "exited" with a nonzero exit code on failure', async () => {
    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: 'exit 7',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(7);
  });

  it('reports the signal that terminated the process when it kills itself', async () => {
    const result = await runForegroundCommand({
      shellPath: SHELL,
      // The shell sends itself SIGTERM rather than exiting normally.
      command: 'kill -TERM $$; sleep 5',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    expect(result.status).toBe('exited');
    expect(result.exitCode).toBeNull();
    expect(result.terminationSignal).toBe('SIGTERM');
  });

  it('closes stdin so a command reading it terminates instead of hanging', async () => {
    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: 'cat',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    // `cat` sees immediate EOF on a closed stdin and exits clean, rather
    // than blocking until the timeout kills it.
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does not source shell profiles — not a login shell', async () => {
    // A real login shell would source ~/.bash_profile; a plain `-c` shell
    // must not, no matter what HOME points at.
    const fakeHome = mkdtempSync(join(tmpdir(), 'fake-home-'));
    writeFileSync(join(fakeHome, '.bash_profile'), 'export PROFILE_MARKER=sourced\n');
    try {
      const result = await runForegroundCommand({
        shellPath: SHELL,
        command: 'echo "${PROFILE_MARKER:-unset}"',
        cwd: workDir,
        env: { ...process.env, HOME: fakeHome },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      expect(result.stdout.trim()).toBe('unset');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('resolves as cancelled without spawning when the signal is already aborted', async () => {
    const marker = join(workDir, 'should-not-exist.txt');
    const controller = new AbortController();
    controller.abort();

    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: `touch '${marker}'`,
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      abortSignal: controller.signal,
    });

    expect(result).toEqual({
      status: 'cancelled',
      exitCode: null,
      terminationSignal: null,
      durationMs: result.durationMs,
      stdout: '',
      stderr: '',
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects when the shell itself cannot be spawned at all', async () => {
    await expect(
      runForegroundCommand({
        shellPath: join(workDir, 'no-such-shell-binary'),
        command: 'echo hi',
        cwd: workDir,
        env: process.env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      }),
    ).rejects.toThrow();
  });

  it(
    'times out and terminates both the command and a descendant it spawned',
    async () => {
      const marker = join(workDir, 'descendant-marker.txt');
      const result = await runForegroundCommand({
        shellPath: SHELL,
        // The descendant would write its marker well after the timeout;
        // the main command sleeps far longer than the timeout too.
        command: `(sleep 0.4 && touch '${marker}') & sleep 5`,
        cwd: workDir,
        env: process.env,
        timeoutMs: 100,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      expect(result.status).toBe('timed_out');

      // Wait past when the descendant would have written its marker had it
      // survived the kill.
      await wait(700);
      expect(existsSync(marker)).toBe(false);
    },
    10_000,
  );

  it(
    'times out the gated child lifecycle even when watchdog arming stalls',
    async () => {
      const marker = join(workDir, 'must-remain-gated.txt');
      const controlledWatchdog = createControlledWatchdog({
        armNeverSettles: true,
      });
      vi.spyOn(
        parentDeathWatchdogModule,
        'startParentDeathWatchdog',
      ).mockResolvedValue(controlledWatchdog.watchdog);
      const promise = runForegroundCommand({
        shellPath: SHELL,
        command: `printf started > ${JSON.stringify(marker)}`,
        cwd: workDir,
        env: process.env,
        timeoutMs: 50,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      try {
        const result = await Promise.race([
          promise,
          wait(1_000).then(() => {
            throw new Error('gated child outlived timeoutMs while arm was stalled');
          }),
        ]);

        expect(result.status).toBe('timed_out');
        expect(existsSync(marker)).toBe(false);
      } finally {
        try {
          process.kill(-controlledWatchdog.processGroupId(), 'SIGKILL');
        } catch {
          // Production should already have removed the complete group.
        }
        await promise;
      }
    },
    10_000,
  );

  it(
    'terminates the process group and yields "cancelled" on a mid-run abort',
    async () => {
      const controller = new AbortController();
      const promise = runForegroundCommand({
        shellPath: SHELL,
        command: 'sleep 5',
        cwd: workDir,
        env: process.env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        abortSignal: controller.signal,
      });

      await wait(100);
      controller.abort();
      const result = await promise;

      expect(result.status).toBe('cancelled');
      expect(result.durationMs).toBeLessThan(4000);
    },
    10_000,
  );

  it(
    'hard-kills immediately and rejects if the watchdog fails during cancellation',
    async () => {
      const readyPath = join(workDir, 'watchdog-failure-ready.txt');
      const controller = new AbortController();
      const controlledWatchdog = createControlledWatchdog();
      vi.spyOn(
        parentDeathWatchdogModule,
        'startParentDeathWatchdog',
      ).mockResolvedValue(controlledWatchdog.watchdog);
      const killSpy = vi.spyOn(process, 'kill');
      const promise = runForegroundCommand({
        shellPath: SHELL,
        command:
          `trap '' TERM\n` +
          `printf ready > "$READY_PATH"\n` +
          'while :; do :; done',
        cwd: workDir,
        env: { ...process.env, READY_PATH: readyPath },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        abortSignal: controller.signal,
      });

      try {
        await waitForPath(readyPath);
        controller.abort();
        const callsBeforeFailure = killSpy.mock.calls.length;

        controlledWatchdog.fail();

        expect(killSpy.mock.calls.slice(callsBeforeFailure)).toContainEqual([
          -controlledWatchdog.processGroupId(),
          'SIGKILL',
        ]);
        await expect(promise).rejects.toMatchObject({
          name: 'ParentDeathWatchdogError',
          message: 'parent-death watchdog stopped while its target was active',
        });
      } finally {
        controller.abort();
        try {
          process.kill(-controlledWatchdog.processGroupId(), 'SIGKILL');
        } catch {
          // Production should already have removed the complete group.
        }
        await promise.catch(() => undefined);
      }
    },
    10_000,
  );

  it(
    'does not leave a background descendant running after the shell exits normally',
    async () => {
      const marker = join(workDir, 'straggler-marker.txt');
      const result = await runForegroundCommand({
        shellPath: SHELL,
        // The shell itself returns immediately, well before its background
        // job would otherwise write the marker.
        command: `(sleep 0.3 && touch '${marker}') & exit 0`,
        cwd: workDir,
        env: process.env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });

      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);

      await wait(600);
      expect(existsSync(marker)).toBe(false);
    },
    10_000,
  );

  it(
    'trips the output limit and terminates the process well before its natural end',
    async () => {
      const result = await runForegroundCommand({
        shellPath: SHELL,
        command: 'while true; do printf "0123456789"; done',
        cwd: workDir,
        env: process.env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: 500,
      });

      expect(result.status).toBe('output_limit_exceeded');
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(500);
      // Cut short well before the (otherwise infinite) command's timeout budget.
      expect(result.durationMs).toBeLessThan(DEFAULT_TIMEOUT_MS);
    },
    10_000,
  );

  it('enforces the output ceiling on raw bytes, not decoded string length', async () => {
    // Each repetition is the 3-byte UTF-8 encoding of '中': 30 reps is 90
    // raw bytes but only 30 UTF-16 code units. A limit of 50 trips under
    // correct byte counting but would NOT trip if bytes were mistaken for
    // decoded characters (30 < 50).
    const result = await runForegroundCommand({
      shellPath: SHELL,
      command: `printf '\\xe4\\xb8\\xad%.0s' {1..30}`,
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: 50,
    });

    expect(result.status).toBe('output_limit_exceeded');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(50);
  });

  it(
    'does not hang past the drain deadline when a descendant holds the inherited pipe open',
    async () => {
      const startedAt = Date.now();
      const result = await runForegroundCommand({
        shellPath: SHELL,
        // The shell exits immediately; its background descendant ignores
        // SIGTERM and would otherwise hold stdout open for 5 seconds.
        command: `(trap '' TERM; sleep 5) & exit 0`,
        cwd: workDir,
        env: process.env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('exited');
      // Bounded by the drain deadline (plus the stray-kill escalation),
      // nowhere near the descendant's 5-second sleep.
      expect(elapsedMs).toBeLessThan(3000);
    },
    10_000,
  );

  it(
    'settles exactly once when a timeout and a natural exit race',
    async () => {
      // The command finishes at roughly the same instant the timeout fires;
      // run it a few times to exercise the race in both directions. Either
      // outcome is acceptable — what matters is a single, well-formed result.
      for (let i = 0; i < 10; i++) {
        const result = await runForegroundCommand({
          shellPath: SHELL,
          command: 'sleep 0.03; exit 3',
          cwd: workDir,
          env: process.env,
          timeoutMs: 30,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        });

        expect(['exited', 'timed_out']).toContain(result.status);
        if (result.status === 'exited') {
          expect(result.exitCode).toBe(3);
        } else {
          expect(result.exitCode).toBeNull();
        }
      }
    },
    10_000,
  );

  it('releases the abort listener once the call completes normally', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await runForegroundCommand({
      shellPath: SHELL,
      command: 'exit 0',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      abortSignal: controller.signal,
    });

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('clears its timers once the call completes normally', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    await runForegroundCommand({
      shellPath: SHELL,
      command: 'exit 0',
      cwd: workDir,
      env: process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });

    // At minimum, the pending timeout-budget timer must be cleared rather
    // than left to fire after the call has already settled.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
