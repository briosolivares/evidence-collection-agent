import { Box, Text, useApp } from 'ink';
import { useEffect, useReducer, useRef } from 'react';

import type { RunHandle } from '../bridge/runSession.js';
import type { SherlockConfig } from '../config.js';
import { createDemoScript, playDemo } from '../demo.js';
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

  useEffect(() => {
    if (!demo) return;
    return playDemo(createDemoScript(Date.now()), dispatch);
  }, [demo]);

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
      <Transcript items={state.transcript} />
      {running && state.live !== undefined && (
        <LiveRegion
          config={config}
          live={state.live}
          cancelling={state.mode === 'cancelling'}
        />
      )}
      <Box flexDirection="column" marginTop={1}>
        <Composer disabled={state.mode !== 'idle'} onSubmit={handleSubmit} />
        <Text color={theme.muted}>  /help for commands</Text>
      </Box>
    </Box>
  );
}
