// Development-only /evals composition. `main.tsx` dynamically imports this
// module only from a git checkout, so installed Sherlock never resolves the
// eval harness or its datasets.

import type { TuiEvalRuntimeDeps } from './bridge/evalRuntime.js';
import { createTuiEvalRuntime } from './bridge/evalRuntime.js';
import {
  discoverEvalTasks,
  startEvalBatch,
  type EvalRunner,
} from './bridge/evalSession.js';
import type { EvalsFeature } from './bridge/evalsFeature.js';
import { EvalsLiveRegion } from './components/EvalsLiveRegion.js';
import { EvalsMenu } from './components/EvalsMenu.js';

interface EvalsFeatureOptions {
  evalsDir: string;
  resultsDir: string;
  runner: EvalRunner;
}

/** Build the eval UI adapter around a runner. Exported for dev-only tests. */
export function createEvalsFeature(options: EvalsFeatureOptions): EvalsFeature {
  return {
    listTasks: () => discoverEvalTasks(options.evalsDir),
    startBatch: (tasks, k, concurrency, onAction, requestPermission) =>
      startEvalBatch(tasks, k, concurrency, {
        onAction,
        evalsDir: options.evalsDir,
        resultsDir: options.resultsDir,
        runner: options.runner,
        ...(requestPermission === undefined ? {} : { requestPermission }),
      }),
    Menu: EvalsMenu,
    LiveRegion: EvalsLiveRegion,
  };
}

export interface DevelopmentEvalsOptions extends TuiEvalRuntimeDeps {
  evalsDir: string;
  resultsDir: string;
}

export interface DevelopmentEvals {
  feature: EvalsFeature;
  close(): Promise<void>;
}

/** Create the complete checkout-only eval runtime and UI adapter. */
export function createDevelopmentEvals(
  options: DevelopmentEvalsOptions,
): DevelopmentEvals {
  const { evalsDir, resultsDir, ...runtimeOptions } = options;
  const runtime = createTuiEvalRuntime(runtimeOptions);
  return {
    feature: createEvalsFeature({
      evalsDir,
      resultsDir,
      runner: runtime.startRun,
    }),
    close: () => runtime.close(),
  };
}
