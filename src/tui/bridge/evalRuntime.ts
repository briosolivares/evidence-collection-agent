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
    opts?: { startUrl?: string; requestPermission?: RunSessionDeps['requestPermission'] },
  ) => RunHandle;
  authenticatedProfileDir: string;
  browserExecutablePath?: string;
  runsBaseDir?: string;
  runConfig?: Pick<
    RunSessionDeps,
    'model' | 'harness' | 'maxTurns' | 'maxContextTokens' | 'tracingDelegate'
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
        // Headed trials run in the user's visible persistent browser, so
        // the question dialog is live here (user ruling 2026-08-13:
        // always-on for headed TUI evals) — the user can answer questions
        // and act in the browser mid-trial (e.g. complete a login). The
        // batch's report is labeled whenever a dialog was actually
        // answered (see evalSession's assistedDialogs), so assisted scores
        // never masquerade as unassisted ones.
        return deps.authenticatedRunner(task, onEvent, {
          ...(opts.startUrl === undefined ? {} : { startUrl: opts.startUrl }),
          ...(opts.requestPermission === undefined
            ? {}
            : { requestPermission: opts.requestPermission }),
        });
      }

      let inner: RunHandle | undefined;
      let cancelled = false;
      const done = browserRuntime
        .withBrowser(false, async (browser) => {
          // Deliberately no requestPermission: headless trials run in an
          // invisible isolated browser (nothing for a human to act in) and
          // are the lane whose scores stay comparable to CLI batches —
          // interactive tools fail closed here, same as the CLI runner.
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
