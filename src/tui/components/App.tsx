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
import type {
  PermissionDecision,
  PermissionRequest,
} from '../../tools/registry.js';
import type { AskUserAnswers } from '../../tools/index.js';
import type { SherlockConfig } from '../config.js';
import { createDemoScript, playDemo } from '../demo.js';
import { scanRuns, type RunListEntry } from '../runScanner.js';
import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../store/reducer.js';
import type { BannerIdentity, UiEvent } from '../store/state.js';
import { theme } from '../theme.js';
import { Composer } from './Composer.js';
import { EvalsMenu } from './EvalsMenu.js';
import { QuestionDialog } from './QuestionDialog.js';
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
    opts?: {
      startUrl?: string;
      requestPermission?: (
        request: PermissionRequest,
      ) => Promise<PermissionDecision>;
    },
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
  // A paused interactive tool call: the question plus its resolver (the
  // ToolUseConfirm shape). Deliberately App-local, not reducer state — a
  // resolve function has no place in the pure store.
  const [question, setQuestion] = useState<
    | {
        request: PermissionRequest;
        resolve: (decision: PermissionDecision) => void;
      }
    | undefined
  >(undefined);
  const batchRunner = evalRunner ?? runner;

  const settleQuestion = (decision: PermissionDecision) => {
    setQuestion((current) => {
      // Resolving twice is harmless (first resolution wins), so racing a
      // dialog submit against run teardown needs no coordination.
      current?.resolve(decision);
      return undefined;
    });
  };

  const requestPermission = (
    request: PermissionRequest,
  ): Promise<PermissionDecision> =>
    new Promise((resolve) => {
      setQuestion({ request, resolve });
    });

  // The dialog answers through the same event dispatcher the run streams
  // through; terminal events also close a dialog the bridge has already
  // denied via its abort race (or that a failed run abandoned).
  const onRunEvent = (event: UiEvent) => {
    if (
      event.type === 'run_finished' ||
      event.type === 'run_cancelled' ||
      event.type === 'run_failed'
    ) {
      settleQuestion({
        behavior: 'deny',
        feedback: 'The run ended before the user answered.',
      });
    }
    dispatch(event);
  };

  useEffect(() => {
    if (!demo) return;
    return playDemo(createDemoScript(Date.now()), dispatch);
  }, [demo]);

  // Esc cancels an in-flight run (R9). During an eval batch it cancels
  // the current trial and skips the rest; the overlays handle their own
  // Esc. A no-op while idle. While a question dialog is open the dialog
  // owns Esc (dismiss = deny; the run continues) — cancelling still works
  // because the next Esc, dialog closed, lands here.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (question !== undefined) return;
    if (state.mode === 'running') {
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
    const routed = routeInput(text);
    switch (routed.kind) {
      case 'task':
        dispatch({ type: 'submit_task', text: routed.text });
        if (runner !== undefined) {
          runHandle.current = runner(routed.text, onRunEvent, {
            requestPermission,
          });
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
    question !== undefined
      ? '(answer the question above)'
      : state.mode === 'runsList' || state.mode === 'evalsMenu'
        ? '(menu open — esc to close)'
        : state.mode === 'evalsRunning'
          ? '(evals running — esc to stop)'
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
      {question !== undefined && (
        <QuestionDialog
          toolName={question.request.toolName}
          input={question.request.input}
          onSubmit={(answers: AskUserAnswers) =>
            settleQuestion({
              behavior: 'allow',
              updatedInput: {
                ...(question.request.input as object),
                answers,
              },
            })
          }
          onDismiss={() =>
            settleQuestion({
              behavior: 'deny',
              feedback:
                'The user dismissed the question. Continue without this ' +
                'information or finish the task.',
            })
          }
        />
      )}
      <Box flexDirection="column" marginTop={1}>
        <Composer
          disabled={state.mode !== 'idle'}
          hint={composerHint}
          onSubmit={handleSubmit}
        />
        <Text color={theme.muted}>  /help for commands</Text>
      </Box>
    </Box>
  );
}
