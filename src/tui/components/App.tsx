import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';

import {
  discoverEvalTasks,
  startEvalBatch,
  type EvalBatchHandle,
  type EvalRunner,
  type EvalTaskChoice,
} from '../bridge/evalSession.js';
import type { RunHandle } from '../bridge/runSession.js';
import type { SherlockConfig } from '../config.js';
import { createDemoScript, playDemo } from '../demo.js';
import { scanRuns, type RunListEntry } from '../runScanner.js';
import {
  createInitialState,
  deriveSuggestions,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../store/reducer.js';
import type { BannerIdentity, UiEvent } from '../store/state.js';
import { theme } from '../theme.js';
import { ArtifactRail } from './ArtifactRail.js';
import { ArtifactsPanel } from './ArtifactsPanel.js';
import { Composer } from './Composer.js';
import { EvalsMenu } from './EvalsMenu.js';
import { EvalsLiveRegion } from './EvalsLiveRegion.js';
import { LiveRegion } from './LiveRegion.js';
import { RunsList } from './RunsList.js';
import { Transcript } from './Transcript.js';

interface AppProps {
  config: SherlockConfig;
  /** False renders the missing-API-key warning banner. */
  apiKeyPresent: boolean;
  /** Who/where the welcome card greets ({name, model, cwd}); computed in
   * main.tsx. Optional — absent (bare test renders) the card falls back
   * to its generic, deterministic form. */
  identity?: BannerIdentity;
  /** Play the canned demo investigation on mount (`--demo`). */
  demo?: boolean;
  /** Starts a real agent run (wired to the runtime by main.tsx); absent
   * in demo mode, where tasks only append to the transcript. */
  runner?: (
    task: string,
    onEvent: (event: UiEvent) => void,
    opts?: { startUrl?: string },
  ) => RunHandle;
  /** Eval-specific runner: isolated headless normally, persistent headed for auth. */
  evalRunner?: EvalRunner;
  /** Test seam for /exit; defaults to Ink's app exit. */
  onExit?: () => void;
}

/**
 * The Sherlock shell: transcript over <Static>, the live region while a
 * run is active, overlays for /runs and /evals, slash routing, and the
 * persistent composer.
 */
export function App({
  config,
  apiKeyPresent,
  identity,
  demo = false,
  runner,
  evalRunner,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    reduce,
    { apiKeyPresent, completionVerb: config.completionVerb, identity },
    createInitialState,
  );
  const runHandle = useRef<RunHandle | undefined>(undefined);
  const evalHandle = useRef<EvalBatchHandle | undefined>(undefined);
  const [runEntries, setRunEntries] = useState<readonly RunListEntry[]>([]);
  const [evalTasks, setEvalTasks] = useState<readonly EvalTaskChoice[]>([]);
  const batchRunner = evalRunner ?? runner;

  useEffect(() => {
    if (!demo) return;
    return playDemo(createDemoScript(Date.now()), dispatch);
  }, [demo]);

  // Esc cancels an in-flight run (R9) — unless an artifact detail card
  // is open, which Esc closes instead (the reducer-owned artifact
  // substate exists precisely so this handler can check that precedence;
  // the rail itself never listens for Esc). During an eval batch it
  // cancels the current trial and skips the rest; the overlays handle
  // their own Esc. A no-op while idle.
  //
  // Tab is routed here whole, as one tab_pressed action: the reducer
  // arbitrates its meaning — suggestion completion while the derived
  // panel is up, otherwise artifacts focus/blur (design decision 4) —
  // against the same state it mutates, so exactly one handler owns the
  // key and no stale mirror of composer state is consulted.
  useInput((_input, key) => {
    if (key.tab) {
      dispatch({ type: 'tab_pressed' });
      return;
    }
    if (!key.escape) return;
    if (state.mode === 'artifacts') {
      // Same precedence as during the run: close an open detail card
      // first; from the rows view, return the keys to the composer.
      if (state.artifactUi.view === 'detail') {
        dispatch({ type: 'artifact_close_detail' });
      } else {
        dispatch({ type: 'artifacts_blur' });
      }
      return;
    }
    if (state.mode === 'running') {
      if (state.artifactUi.view === 'detail') {
        dispatch({ type: 'artifact_close_detail' });
        return;
      }
      dispatch({ type: 'cancel_requested' });
      if (evalHandle.current !== undefined) evalHandle.current.cancel();
      else runHandle.current?.cancel();
      return;
    }
    if (state.mode === 'evalsRunning') {
      evalHandle.current?.cancel();
    }
  });

  const handleSubmit = (text: string) => {
    // The field reset lives with the rest of the composer substate in
    // the reducer; routing continues on the already-captured text.
    dispatch({ type: 'composer_submitted' });
    const routed = routeInput(text);
    switch (routed.kind) {
      case 'task':
        dispatch({ type: 'submit_task', text: routed.text });
        if (runner !== undefined) {
          runHandle.current = runner(routed.text, dispatch);
          void runHandle.current.done.finally(() => {
            runHandle.current = undefined;
          });
        }
        return;
      case 'help':
        dispatch({ type: 'notice', text: HELP_TEXT });
        return;
      case 'runs':
        setRunEntries(scanRuns(config.runsBaseDir));
        dispatch({ type: 'open_runs' });
        return;
      case 'artifacts':
        // Re-render the panel for the most recent run and focus it —
        // with or without a completion summary (cancelled and
        // budget-exceeded runs keep their artifacts in state).
        if (state.artifacts.length === 0) {
          dispatch({
            type: 'notice',
            text: 'No artifacts to browse yet — run a task that publishes some first.',
          });
          return;
        }
        dispatch({ type: 'artifacts_focus' });
        return;
      case 'evals':
        if (batchRunner === undefined) {
          dispatch({
            type: 'notice',
            text: 'Evals need a live browser session — not available in --demo.',
          });
          return;
        }
        setEvalTasks(discoverEvalTasks(config.evalsDir));
        dispatch({ type: 'open_evals' });
        return;
      case 'exit':
        (onExit ?? exit)();
        return;
      case 'unknown':
        dispatch({ type: 'notice', text: unknownCommandNotice(routed.command) });
        return;
    }
  };

  const startEvals = (tasks: string[], k: number, concurrency: number) => {
    if (batchRunner === undefined) return;
    evalHandle.current = startEvalBatch(tasks, k, concurrency, {
      onAction: dispatch,
      evalsDir: config.evalsDir,
      resultsDir: config.evalResultsDir,
      runner: batchRunner,
    });
    void evalHandle.current.done.finally(() => {
      evalHandle.current = undefined;
    });
  };

  const running = state.mode === 'running' || state.mode === 'cancelling';
  const composerHint =
    state.mode === 'runsList' || state.mode === 'evalsMenu'
      ? '(menu open — esc to close)'
      : state.mode === 'evalsRunning'
        ? '(evals running — esc to stop)'
        : state.mode === 'artifacts'
          ? '(browsing artifacts — esc to return)'
          : '(waiting for agent…)';

  return (
    <Box flexDirection="column">
      <Transcript items={state.transcript} verbose={config.verbose} />
      {running && state.live !== undefined && (
        <LiveRegion
          config={config}
          live={state.live}
          cancelling={state.mode === 'cancelling'}
        />
      )}
      {/* Mounted for the whole run (it renders nothing until the first
          publish) so its key subscription is registered by the submit
          keystroke, not by a mid-run publish event — see ArtifactRail. */}
      {state.mode === 'running' && (
        <ArtifactRail
          artifacts={state.artifacts}
          ui={state.artifactUi}
          runDir={state.live?.runDir}
          dispatch={dispatch}
        />
      )}
      {state.mode === 'evalsRunning' && state.evalsLive !== undefined && (
        <EvalsLiveRegion trials={state.evalsLive} />
      )}
      {state.mode === 'runsList' && (
        <RunsList
          entries={runEntries}
          onClose={() => dispatch({ type: 'close_overlay' })}
        />
      )}
      {state.mode === 'evalsMenu' && (
        <EvalsMenu
          tasks={evalTasks}
          onClose={() => dispatch({ type: 'close_overlay' })}
          onConfirm={startEvals}
        />
      )}
      {/* The completion summary: passive above the composer while idle,
          focused (input-owning) in artifacts mode. Between eval trials
          the mode is evalsRunning, never idle, so no panel mid-batch.
          /artifacts enters artifacts mode with no summary recorded (a
          cancelled/budget-exceeded run's retained artifacts): the panel
          then renders artifacts-only, and only while focused. */}
      {(state.mode === 'artifacts' ||
        (state.mode === 'idle' && state.completedRun !== undefined)) && (
        <ArtifactsPanel
          summary={state.completedRun}
          artifacts={state.artifacts}
          ui={state.artifactUi}
          focused={state.mode === 'artifacts'}
          runDir={state.completedRun?.runDir ?? state.lastRunDir}
          dispatch={dispatch}
        />
      )}
      <Box flexDirection="column" marginTop={1}>
        <Composer
          disabled={state.mode !== 'idle'}
          hint={composerHint}
          composer={state.composer}
          suggestions={deriveSuggestions(state)}
          dispatch={dispatch}
          onSubmit={handleSubmit}
        />
        <Text color={theme.muted}>  /help for commands</Text>
      </Box>
    </Box>
  );
}
