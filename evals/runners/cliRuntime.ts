import type { BrowserController } from '../../src/browser/controller.js';
import { runTask, usableStartUrl, type RunTaskConfig } from '../../src/cli/runTask.js';
import type { ProgressEvent } from '../../src/model/callModel.js';
import type { RunTaskFn } from '../types.js';
import type { EvalBrowserRuntime } from './browserRuntime.js';

export interface BrowserBackedRunTaskOptions {
  browserRuntime: EvalBrowserRuntime;
  model: string;
  runsBaseDir: string;
  /**
   * Protocol settings layered over the eval harness defaults — the switches
   * the CLI exposes as flags.
   *
   * Spread over `{}` rather than replacing it, so leaving a field unset keeps
   * the harness's own default instead of forcing every caller to restate all
   * of them.
   */
  harness?: Pick<NonNullable<RunTaskConfig['harness']>, 'contractAuthor'>;
  onProgress?: (taskName: string, trialNumber: number, k: number, event: ProgressEvent) => void;
  /** Test seam for the production composition root. */
  runTaskFn?: (taskText: string, config: RunTaskConfig) => Promise<{ runDir: string }>;
}

/** Build the CLI agent function while keeping browser policy outside runTask. */
export function createBrowserBackedRunTask(options: BrowserBackedRunTaskOptions): RunTaskFn {
  const runTaskFn = options.runTaskFn ?? runTask;
  return (taskText, evalOptions) => {
    const startUrl = usableStartUrl(evalOptions.startUrl);
    return options.browserRuntime.withBrowser(evalOptions.headed, (browser: BrowserController) =>
      runTaskFn(taskText, {
        browser,
        model: options.model,
        runsBaseDir: options.runsBaseDir,
        // Eval batches always run the initializer→worker→verifier harness
        // (judge-design.md step 5): defaults apply (2 worker cycles,
        // production initializer/verifier models). Interactive surfaces
        // (REPL/TUI) stay verifier-less until validated. The protocol
        // switches come from the CLI so a batch records which path it ran.
        harness: { ...options.harness },
        ...(startUrl === undefined ? {} : { startUrl }),
        ...(options.onProgress === undefined
          ? {}
          : {
              onProgress: (event) =>
                options.onProgress!(
                  evalOptions.taskName,
                  evalOptions.trialNumber,
                  evalOptions.k,
                  event,
                ),
            }),
      }),
    );
  };
}
