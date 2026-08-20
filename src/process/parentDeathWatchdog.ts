import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = 1;
const CONTROL_TIMEOUT_MS = 5_000;
const WATCHDOG_MODULE = fileURLToPath(new URL('./parentDeathWatchdog.mjs', import.meta.url));

export class ParentDeathWatchdogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentDeathWatchdogError';
  }
}

export interface ParentDeathWatchdog {
  /** Arm the watcher for one POSIX process group. May be called exactly once. */
  arm(processGroupId: number): Promise<void>;
  /**
   * Tell the watcher that the target group has already been terminated.
   * Idempotent and bounded; no watcher process remains after this resolves.
   */
  disarm(): Promise<void>;
  /** Subscribe to an unexpected watcher failure while the target is active. */
  onFailure(listener: (error: ParentDeathWatchdogError) => void): () => void;
}

type WatchdogMessageKind = 'ready' | 'armed' | 'disarmed';

/**
 * Start a tiny detached supervisor whose IPC EOF is owned by this process.
 *
 * Once armed, a hard death of this process closes the IPC channel in the
 * kernel. The independent supervisor then terminates the target process group
 * even though no JavaScript cleanup in this process can run. The supervisor
 * receives an empty environment and no stdio, so it cannot inherit caller
 * secrets or hold application output pipes open.
 */
export async function startParentDeathWatchdog(): Promise<ParentDeathWatchdog> {
  if (process.platform === 'win32') {
    throw new ParentDeathWatchdogError(
      'parent-death process supervision requires POSIX process groups',
    );
  }

  let child: ChildProcess;
  try {
    child = fork(WATCHDOG_MODULE, [], {
      detached: true,
      env: {},
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
  } catch {
    throw new ParentDeathWatchdogError('parent-death watchdog failed to start');
  }

  const controller = new WatchdogController(child);
  await controller.waitUntilReady();
  return controller;
}

class WatchdogController implements ParentDeathWatchdog {
  private readonly child: ChildProcess;
  private readonly listeners = new Set<(error: ParentDeathWatchdogError) => void>();
  private expectedStop = false;
  private stopped = false;
  private armed = false;
  private controlOperation: Promise<void> | undefined;
  private failureReported = false;

  constructor(child: ChildProcess) {
    this.child = child;
    child.once('error', () => this.reportFailure());
    child.once('exit', () => {
      this.stopped = true;
      if (!this.expectedStop) this.reportFailure();
    });
  }

  async waitUntilReady(): Promise<void> {
    try {
      await this.waitForMessage('ready');
    } catch (error: unknown) {
      this.stopNow();
      await this.waitForExit();
      throw stableWatchdogError(error, 'parent-death watchdog failed to become ready');
    }
  }

  async arm(processGroupId: number): Promise<void> {
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
      throw new ParentDeathWatchdogError('parent-death watchdog received an invalid process group');
    }
    if (this.armed) {
      throw new ParentDeathWatchdogError('parent-death watchdog is already armed');
    }
    if (this.stopped) {
      throw new ParentDeathWatchdogError('parent-death watchdog stopped before arming');
    }

    const operation = this.exchange(
      { version: PROTOCOL_VERSION, kind: 'arm', processGroupId },
      'armed',
    );
    this.controlOperation = operation;
    try {
      await operation;
      this.armed = true;
    } finally {
      if (this.controlOperation === operation) this.controlOperation = undefined;
    }
  }

  async disarm(): Promise<void> {
    if (this.expectedStop) {
      await this.waitForExit();
      return;
    }

    this.expectedStop = true;
    this.listeners.clear();
    if (this.controlOperation !== undefined) {
      try {
        await this.controlOperation;
      } catch {
        // The operation's caller owns its result. Disarm still has to reap
        // the supervisor on every path.
      }
    }
    if (!this.stopped && this.child.connected) {
      try {
        await this.exchange({ version: PROTOCOL_VERSION, kind: 'disarm' }, 'disarmed');
      } catch {
        // The target group is already terminated by contract. A failed
        // disarm must still reap the supervisor rather than leak a process.
      }
    }
    if (this.child.connected) this.child.disconnect();
    await this.waitForExit();
  }

  onFailure(listener: (error: ParentDeathWatchdogError) => void): () => void {
    if (this.failureReported && !this.expectedStop) {
      queueMicrotask(() => listener(unexpectedStopError()));
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async exchange(
    message: Record<string, unknown>,
    expectedKind: WatchdogMessageKind,
  ): Promise<void> {
    const reply = this.waitForMessage(expectedKind);
    await Promise.all([this.send(message), reply]);
  }

  private send(message: Record<string, unknown>): Promise<void> {
    if (this.stopped || !this.child.connected) {
      return Promise.reject(unexpectedStopError());
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.send(message, (error) => {
          if (error === null) resolve();
          else reject(unexpectedStopError());
        });
      } catch {
        reject(unexpectedStopError());
      }
    });
  }

  private waitForMessage(expectedKind: WatchdogMessageKind): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ParentDeathWatchdogError('parent-death watchdog timed out'));
      }, CONTROL_TIMEOUT_MS);
      const onMessage = (message: unknown): void => {
        if (
          !isRecord(message) ||
          message.version !== PROTOCOL_VERSION ||
          message.kind !== expectedKind ||
          Object.keys(message).length !== 2
        ) {
          cleanup();
          reject(new ParentDeathWatchdogError('parent-death watchdog protocol failed'));
          return;
        }
        cleanup();
        resolve();
      };
      const onExit = (): void => {
        cleanup();
        reject(unexpectedStopError());
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.child.off('message', onMessage);
        this.child.off('exit', onExit);
      };

      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
    });
  }

  private waitForExit(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
      }, CONTROL_TIMEOUT_MS);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private stopNow(): void {
    this.expectedStop = true;
    if (this.child.connected) this.child.disconnect();
    this.child.kill('SIGKILL');
  }

  private reportFailure(): void {
    if (this.failureReported || this.expectedStop) return;
    this.failureReported = true;
    const error = unexpectedStopError();
    for (const listener of this.listeners) listener(error);
  }
}

function unexpectedStopError(): ParentDeathWatchdogError {
  return new ParentDeathWatchdogError('parent-death watchdog stopped while its target was active');
}

function stableWatchdogError(error: unknown, fallback: string): ParentDeathWatchdogError {
  return error instanceof ParentDeathWatchdogError ? error : new ParentDeathWatchdogError(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
