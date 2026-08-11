import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';

import type { RunHandle } from '../bridge/runSession.js';
import type { SherlockConfig } from '../config.js';
import { createDemoScript, playDemo } from '../demo.js';
import { loadRunSummary, scanRuns, type RunListEntry } from '../runScanner.js';
import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../store/reducer.js';
import type { UiEvent } from '../store/state.js';
import { theme } from '../theme.js';
import { Composer } from './Composer.js';
import { LiveRegion } from './LiveRegion.js';
import { RunsList } from './RunsList.js';
import { Transcript } from './Transcript.js';

interface AppProps {
  config: SherlockConfig;
  /** False renders the missing-API-key warning banner. */
  apiKeyPresent: boolean;
  /** Play the canned demo investigation on mount (`--demo`). */
  demo?: boolean;
  /** Starts a real agent run (wired to the runtime by main.tsx); absent
   * in demo mode, where tasks only append to the transcript. */
  runner?: (task: string, onEvent: (event: UiEvent) => void) => RunHandle;
  /** Test seam for /exit; defaults to Ink's app exit. */
  onExit?: () => void;
}

/**
 * The Sherlock shell: transcript over <Static>, the live region while a
 * run is active, slash routing, and the persistent composer.
 */
export function App({ config, apiKeyPresent, demo = false, runner, onExit }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    reduce,
    { apiKeyPresent, completionVerb: config.completionVerb },
    createInitialState,
  );
  const runHandle = useRef<RunHandle | undefined>(undefined);
  const [runEntries, setRunEntries] = useState<readonly RunListEntry[]>([]);

  useEffect(() => {
    if (!demo) return;
    return playDemo(createDemoScript(Date.now()), dispatch);
  }, [demo]);

  // Esc cancels an in-flight run (R9): flip to cancelling (status line
  // shows "Wrapping up…") and abort the bridge; the run's rejection then
  // lands as run_cancelled. A no-op in every other mode.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (state.mode !== 'running') return;
    dispatch({ type: 'cancel_requested' });
    runHandle.current?.cancel();
  });

  const handleSubmit = (text: string) => {
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
      case 'exit':
        (onExit ?? exit)();
        return;
      case 'unknown':
        dispatch({ type: 'notice', text: unknownCommandNotice(routed.command) });
        return;
    }
  };

  const running = state.mode === 'running' || state.mode === 'cancelling';

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
      {state.mode === 'runsList' && (
        <RunsList
          entries={runEntries}
          onClose={() => dispatch({ type: 'close_overlay' })}
          onSelect={(entry) => {
            try {
              const summary = loadRunSummary(entry.runDir);
              dispatch({ type: 'show_run_summary', ...summary, runDir: entry.runDir });
            } catch (error) {
              dispatch({ type: 'close_overlay' });
              dispatch({
                type: 'notice',
                text: `Couldn't read that run: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
            }
          }}
        />
      )}
      <Box flexDirection="column" marginTop={1}>
        <Composer disabled={state.mode !== 'idle'} onSubmit={handleSubmit} />
        <Text color={theme.muted}>  /help for commands</Text>
      </Box>
    </Box>
  );
}
