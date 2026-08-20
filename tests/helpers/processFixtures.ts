// Shared polling helpers and the controllable parent-death watchdog fake used
// by the process-spawning tool suites (bash, browser_execute).
import { existsSync } from 'node:fs';

import * as parentDeathWatchdogModule from '../../src/process/parentDeathWatchdog.js';

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await wait(10);
  }
}

export function createControlledWatchdog(options: { armNeverSettles?: boolean } = {}): {
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
