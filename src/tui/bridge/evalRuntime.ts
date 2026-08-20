import { resolve } from 'node:path';

import {
  createEvalBrowserRuntime,
  type EvalBrowserRuntime,
} from '../../../evals/runners/browserRuntime.js';
import type { UiEvent } from '../store/state.js';
import type { EvalRunner } from './evalSession.js';
import { startRun, type RunHandle, type RunSessionDeps } from './runSession.js';

export interface TuiEvalRuntimeDeps {
  /** Browserbase keeps reusing Sherlock's remote interactive session for
   * headed trials. Local trials never use this callback: they lease the
   * explicitly managed eval profile instead of touching attached Chrome. */
  authenticatedRunner: (
    task: string,
    onEvent: (event: UiEvent) => void,
    opts?: { startUrl?: string; requestPermission?: RunSessionDeps['requestPermission'] },
  ) => RunHandle;
  authenticatedProfileDir: string;
  browserExecutablePath?: string;
  runsBaseDir?: string;
  /** Test seams. */
  browserRuntime?: EvalBrowserRuntime;
  startRunFn?: typeof startRun;
}

export interface TuiEvalRuntime {
  startRun: EvalRunner;
  close(): Promise<void>;
}

/**
 * Browser-policy adapter used only by /evals.
 *
 * Normal trials always use the eval runtime's isolated lane. Headed local
 * trials use that runtime's managed persistent profile as well — never the
 * TUI's attached daily browser. Browserbase keeps its existing remote-session
 * reuse because there is no local ambient browser to protect there.
 */
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
      if (opts.headed && browserRuntime.provider === 'browserbase') {
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
        .withBrowser(opts.headed, async (browser) => {
          // Local headed trials remain visible and may ask the TUI's human,
          // but they run against the managed authenticated eval profile.
          // Normal trials deliberately receive no resolver and stay
          // comparable to unattended CLI batches.
          inner = startRunFn(task, {
            browser,
            onEvent,
            ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
            ...(opts.startUrl === undefined ? {} : { startUrl: opts.startUrl }),
            ...(opts.headed && opts.requestPermission !== undefined
              ? { requestPermission: opts.requestPermission }
              : {}),
            authenticated: opts.headed,
            javascriptPolicy: 'allow',
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
