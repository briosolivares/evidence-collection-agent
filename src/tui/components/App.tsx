import { Box, Text, useApp } from 'ink';
import { useEffect, useReducer } from 'react';

import type { SherlockConfig } from '../config.js';
import { createDemoScript, playDemo } from '../demo.js';
import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../store/reducer.js';
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
  /** Test seam for /exit; defaults to Ink's app exit. */
  onExit?: () => void;
}

/**
 * The Sherlock shell: transcript over <Static>, the live region while a
 * run is active, slash routing, and the persistent composer.
 */
export function App({ config, apiKeyPresent, demo = false, onExit }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    reduce,
    { apiKeyPresent, completionVerb: config.completionVerb },
    createInitialState,
  );

  useEffect(() => {
    if (!demo) return;
    return playDemo(createDemoScript(Date.now()), dispatch);
  }, [demo]);

  const handleSubmit = (text: string) => {
    const routed = routeInput(text);
    switch (routed.kind) {
      case 'task':
        dispatch({ type: 'submit_task', text: routed.text });
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
