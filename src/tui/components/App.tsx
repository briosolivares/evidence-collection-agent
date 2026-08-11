import { Box, Text, useApp } from 'ink';
import { useReducer } from 'react';

import type { SherlockConfig } from '../config.js';
import {
  createInitialState,
  HELP_TEXT,
  reduce,
  routeInput,
  unknownCommandNotice,
} from '../store/reducer.js';
import { theme } from '../theme.js';
import { Composer } from './Composer.js';
import { Transcript } from './Transcript.js';

interface AppProps {
  config: SherlockConfig;
  /** False renders the missing-API-key warning banner. */
  apiKeyPresent: boolean;
  /** Test seam for /exit; defaults to Ink's app exit. */
  onExit?: () => void;
}

/**
 * The Sherlock shell: transcript over <Static>, slash routing, and the
 * persistent composer. Tasks append to the transcript; the run bridge
 * (step 4) will pick them up from here.
 */
export function App({ config, apiKeyPresent, onExit }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    reduce,
    { apiKeyPresent },
    createInitialState,
  );

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

  const composerActive = state.mode === 'idle';

  return (
    <Box flexDirection="column">
      <Transcript items={state.transcript} />
      <Box flexDirection="column" marginTop={1}>
        <Composer disabled={!composerActive} onSubmit={handleSubmit} />
        <Text color={theme.muted}>  /help for commands</Text>
      </Box>
    </Box>
  );
}
