import { Box, Text } from 'ink';
import { useState } from 'react';

import type { SherlockConfig } from '../config.js';
import { glyphs, theme } from '../theme.js';
import { Composer } from './Composer.js';

interface AppProps {
  config: SherlockConfig;
  /** False renders the missing-API-key warning banner. */
  apiKeyPresent: boolean;
}

/**
 * The Sherlock shell: banner, transcript area, and the persistent composer
 * anchored at the bottom. Step 1 scaffold — submitting text only echoes a
 * "not wired yet" notice; the session store replaces this in step 2.
 */
export function App({ config, apiKeyPresent }: AppProps) {
  const [notices, setNotices] = useState<readonly string[]>([]);

  const handleSubmit = (text: string) => {
    setNotices((prior) => [
      ...prior,
      `“${text}” — the agent isn't wired up yet; this shell only takes notes.`,
    ]);
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.primary} bold>
          {`${glyphs.spinnerFrames[2]} Sherlock`}
        </Text>
        <Text color={theme.muted}> — evidence collection agent</Text>
      </Box>
      {!apiKeyPresent && (
        <Box marginBottom={1}>
          <Text color={theme.error}>
            {`${glyphs.retried} ANTHROPIC_API_KEY is not set — investigations will fail until it is configured.`}
          </Text>
        </Box>
      )}
      {notices.map((notice, index) => (
        <Box key={index} marginBottom={1}>
          <Text color={theme.muted}>{notice}</Text>
        </Box>
      ))}
      <Composer onSubmit={handleSubmit} />
      <Text color={theme.muted}>  /help for commands</Text>
    </Box>
  );
}
