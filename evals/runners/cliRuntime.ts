import type { BrowserController } from '../../src/browser/controller.js';
import { runTask, usableStartUrl, type RunTaskConfig } from '../../src/cli/runTask.js';
import type { ProgressEvent } from '../../src/model/callModel.js';
import type { ToolProfile } from '../../src/tools/index.js';
import type { RunTaskFn } from '../types.js';
import type { EvalBrowserRuntime } from './browserRuntime.js';

export interface BrowserBackedRunTaskOptions {
  browserRuntime: EvalBrowserRuntime;
  model: string;
  toolProfile: ToolProfile;
  runsBaseDir: string;
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
        toolProfile: options.toolProfile,
        runsBaseDir: options.runsBaseDir,
        // Eval batches always run the initializer→worker→judge harness
        // (judge-design.md step 5): defaults apply (2 worker cycles,
        // production initializer/judge models). Interactive surfaces
        // (REPL/TUI) stay judge-less until validated.
        harness: {},
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
