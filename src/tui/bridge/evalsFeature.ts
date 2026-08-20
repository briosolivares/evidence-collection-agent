import type { ComponentType } from 'react';

import type { PermissionDecision, PermissionRequest } from '../../tools/registry.js';
import type { StoreAction } from '../store/reducer.js';
import type { EvalTrialLive } from '../store/state.js';

/** One development eval task shown in the task picker. */
export interface EvalTaskChoice {
  name: string;
  headed: boolean;
}

/** A running eval batch controlled by the TUI. */
export interface EvalBatchHandle {
  cancel(): void;
  done: Promise<'completed' | 'cancelled' | 'failed'>;
}

export interface EvalsMenuProps {
  tasks: readonly EvalTaskChoice[];
  onConfirm: (tasks: string[], k: number, concurrency: number) => void;
  onClose: () => void;
}

export interface EvalsLiveRegionProps {
  trials: Readonly<Record<string, EvalTrialLive>>;
}

/**
 * The optional eval surface injected by a development checkout.
 *
 * This interface deliberately has no imports from `evals/`, so the normal
 * installed application can load without resolving the development harness.
 */
export interface EvalsFeature {
  listTasks(): readonly EvalTaskChoice[];
  startBatch(
    tasks: readonly string[],
    k: number,
    concurrency: number,
    onAction: (action: StoreAction) => void,
    /** The App's question-dialog resolver; forwarded to headed trials only
     * (user ruling 2026-08-13), and answered dialogs label the report as
     * assisted. */
    requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): EvalBatchHandle;
  Menu: ComponentType<EvalsMenuProps>;
  LiveRegion: ComponentType<EvalsLiveRegionProps>;
}
