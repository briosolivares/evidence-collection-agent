import { resolve } from 'node:path';

import {
  createEvalBrowserRuntime,
  type EvalBrowserRuntime,
} from '../../../evals/runners/browserRuntime.js';
import type { UiEvent } from '../store/state.js';
import type { EvalRunner } from './evalSession.js';
import { startRun, type RunHandle, type RunSessionDeps } from './runSession.js';

export interface TuiEvalRuntimeDeps {
  /** Reuses Sherlock's lazy persistent headed controller for headed trials. */
  authenticatedRunner: (
    task: string,
    onEvent: (event: UiEvent) => void,
    opts?: { startUrl?: string },
  ) => RunHandle;
  authenticatedProfileDir: string;
  browserExecutablePath?: string;
  runsBaseDir?: string;
  runConfig?: Pick<
    RunSessionDeps,
    'model' | 'toolProfile' | 'maxTurns' | 'maxContextTokens' | 'tracingDelegate'
  >;
  /** Test seams. */
  browserRuntime?: EvalBrowserRuntime;
  startRunFn?: typeof startRun;
}

export interface TuiEvalRuntime {
  startRun: EvalRunner;
  close(): Promise<void>;
}

/** Browser-policy adapter used only by /evals. */
export function createTuiEvalRuntime(deps: TuiEvalRuntimeDeps): TuiEvalRuntime {
  const startRunFn = deps.startRunFn ?? startRun;
  const browserRuntime =
    deps.browserRuntime ??
    createEvalBrowserRuntime({
      authenticatedProfileDir: resolve(deps.authenticatedProfileDir),
      ...(deps.browserExecutablePath === undefined
        ? {}
        : { executablePath: deps.browserExecutablePath }),
    });

  return {
    startRun(task, onEvent, opts) {
      if (opts.headed) {
        return deps.authenticatedRunner(task, onEvent, {
          ...(opts.startUrl === undefined ? {} : { startUrl: opts.startUrl }),
        });
      }

      let inner: RunHandle | undefined;
      let cancelled = false;
      const done = browserRuntime
        .withBrowser(false, async (browser) => {
          inner = startRunFn(task, {
            browser,
            onEvent,
            ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
            ...(opts.startUrl === undefined ? {} : { startUrl: opts.startUrl }),
            ...deps.runConfig,
          });
          if (cancelled) inner.cancel();
          return inner.done;
        })
        .catch((error: unknown) => {
          const message = `eval browser failed: ${error instanceof Error ? error.message : String(error)}`;
          onEvent({ type: 'run_failed', message, at: Date.now() });
          return { status: 'failed', message } as const;
        });

      return {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          inner?.cancel();
        },
        done,
      };
    },
    close: () => browserRuntime.close(),
  };
}
