// Session-long wiring: one persistent browser launched lazily on the first
// interactive/authenticated run, handed to later persistent-profile runs,
// and closed at TUI teardown. If the
// browser dies mid-session (window closed, process killed), the failure
// is classified and the next submit relaunches a fresh browser instead of
// failing every subsequent run.

import type { BrowserController } from '../../browser/controller.js';
import type { BrowserSessionProvider } from '../../browser/sessionProvider.js';
import type { UiEvent } from '../store/state.js';
import {
  startRun,
  type RunHandle,
  type RunOutcome,
  type RunSessionDeps,
} from './runSession.js';
import { isBrowserDeathMessage } from './browserDeath.js';

export { isBrowserDeathMessage } from './browserDeath.js';

/** What the runtime needs; launch is injectable for tests. */
export interface TuiRuntimeDeps {
  /** Creates session browsers (production: local persistent Chrome). */
  browserSessionProvider: BrowserSessionProvider;
  runsBaseDir?: string;
  /** Test seam: replaces the run-session bridge. */
  startRunFn?: (task: string, deps: RunSessionDeps) => RunHandle;
  /** Extra per-run configuration forwarded to the bridge. */
  runConfig?: Pick<
    RunSessionDeps,
    | 'model'
    | 'harness'
    | 'maxTurns'
    | 'maxContextTokens'
    | 'authenticated'
    | 'javascriptPolicy'
    | 'tracingDelegate'
  >;
  /** Test seam: clock for event stamps. */
  now?: () => number;
}

/** The session runtime the App drives runs through. */
export interface TuiRuntime {
  /** Mark the runtime ready; the persistent browser launches lazily. */
  start(): Promise<void>;
  /** Start one agent run against the session browser. */
  startRun(
    task: string,
    onEvent: (event: UiEvent) => void,
    opts?: {
      startUrl?: string;
      /** The App's question-dialog resolver; omitted (eval runs, demo)
       * interactive tools fail closed. */
      requestPermission?: RunSessionDeps['requestPermission'];
    },
  ): RunHandle;
  /** Close the persistent browser; safe to call once at teardown. */
  shutdown(): Promise<void>;
}

/** Create the session runtime. */
export function createTuiRuntime(deps: TuiRuntimeDeps): TuiRuntime {
  const startRunFn = deps.startRunFn ?? startRun;
  const now = deps.now ?? Date.now;
  let browser: BrowserController | undefined;
  let started = false;
  let browserDead = false;

  const ensureBrowser = async (
    onEvent: (event: UiEvent) => void,
  ): Promise<BrowserController> => {
    if (!started) {
      throw new Error('runtime not started — no browser session');
    }
    if (browser !== undefined && !browserDead) return browser;
    // Relaunch after a browser death: best-effort close of the corpse,
    // then a fresh session for this and later runs.
    const corpse = browser;
    browser = undefined;
    if (corpse !== undefined) {
      try {
        await corpse.close();
      } catch {
        // Already gone.
      }
    }
    browser = await deps.browserSessionProvider.createSession();
    browserDead = false;
    // A relaunch is a brand-new remote session with its own Live View URL,
    // not a resumption of the old one — so this fires on every successful
    // createSession(), not just the first. Local Chrome's controller carries
    // no diagnostics, so this stays silent for the common case; the reducer
    // would also drop a 'local' event on the floor, but there is no reason
    // to emit noise it just has to discard.
    if (browser.sessionDiagnostics !== undefined) {
      const diagnostics = browser.sessionDiagnostics;
      onEvent({
        type: 'browser_session',
        provider: diagnostics.provider,
        ...(diagnostics.sessionId === undefined ? {} : { sessionId: diagnostics.sessionId }),
        ...(diagnostics.liveViewUrl === undefined
          ? {}
          : { liveViewUrl: diagnostics.liveViewUrl }),
      });
    }
    return browser;
  };

  return {
    async start() {
      if (started) {
        throw new Error('runtime already started');
      }
      started = true;
    },

    startRun(task, onEvent, opts) {
      if (!started) {
        throw new Error('runtime not started — no browser session');
      }
      let inner: RunHandle | undefined;
      let cancelled = false;

      const done: Promise<RunOutcome> = (async () => {
        let session: BrowserController;
        try {
          session = await ensureBrowser(onEvent);
        } catch (error) {
          const message = `browser relaunch failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          onEvent({ type: 'run_failed', message, at: now() });
          return { status: 'failed', message } as const;
        }

        inner = startRunFn(task, {
          browser: session,
          onEvent,
          ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
          ...(opts?.startUrl === undefined ? {} : { startUrl: opts.startUrl }),
          ...(opts?.requestPermission === undefined
            ? {}
            : { requestPermission: opts.requestPermission }),
          ...deps.runConfig,
        });
        if (cancelled) inner.cancel();
        const outcome = await inner.done;
        if (outcome.status === 'failed' && isBrowserDeathMessage(outcome.message)) {
          browserDead = true;
        }
        return outcome;
      })();

      return {
        cancel: () => {
          cancelled = true;
          inner?.cancel();
        },
        done,
      };
    },

    async shutdown() {
      const open = browser;
      browser = undefined;
      started = false;
      if (open !== undefined) {
        try {
          await open.close();
        } catch {
          // A dead browser has nothing left to close.
        }
      }
    },
  };
}
