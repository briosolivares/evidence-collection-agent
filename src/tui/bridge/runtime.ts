// Session-long wiring: one persistent browser launched at startup, handed
// to every run, closed at TUI teardown — the same ownership model as the
// REPL (the caller owns the browser; runTask owns only its tab).

import type { BrowserAdapter } from '../../browser/adapter.js';
import type { UiEvent } from '../store/state.js';
import {
  startRun,
  type RunHandle,
  type RunSessionDeps,
} from './runSession.js';

/** What the runtime needs; launch is injectable for tests. */
export interface TuiRuntimeDeps {
  /** Launches the session browser (production: launchPersistentChrome). */
  launchBrowser: () => Promise<BrowserAdapter>;
  runsBaseDir?: string;
  /** Test seam: replaces the run-session bridge. */
  startRunFn?: (task: string, deps: RunSessionDeps) => RunHandle;
  /** Extra per-run configuration forwarded to the bridge. */
  runConfig?: Pick<RunSessionDeps, 'model' | 'maxTurns' | 'maxTokens' | 'tracing'>;
}

/** The session runtime the App drives runs through. */
export interface TuiRuntime {
  /** Launch the persistent browser; call exactly once, before runs. */
  start(): Promise<void>;
  /** Start one agent run against the session browser. */
  startRun(task: string, onEvent: (event: UiEvent) => void): RunHandle;
  /** Close the persistent browser; safe to call once at teardown. */
  shutdown(): Promise<void>;
}

/** Create the session runtime. */
export function createTuiRuntime(deps: TuiRuntimeDeps): TuiRuntime {
  const startRunFn = deps.startRunFn ?? startRun;
  let browser: BrowserAdapter | undefined;

  return {
    async start() {
      if (browser !== undefined) {
        throw new Error('runtime already started');
      }
      browser = await deps.launchBrowser();
    },

    startRun(task, onEvent) {
      if (browser === undefined) {
        throw new Error('runtime not started — no browser session');
      }
      return startRunFn(task, {
        browser,
        onEvent,
        ...(deps.runsBaseDir === undefined ? {} : { runsBaseDir: deps.runsBaseDir }),
        ...deps.runConfig,
      });
    },

    async shutdown() {
      const open = browser;
      browser = undefined;
      if (open !== undefined) {
        await open.close();
      }
    },
  };
}
