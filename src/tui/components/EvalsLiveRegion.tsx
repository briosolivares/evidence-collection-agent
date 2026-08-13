import { Box, Text } from 'ink';

import type { EvalTrialLive } from '../store/state.js';
import { theme } from '../theme.js';

export function EvalsLiveRegion({ trials }: { trials: Readonly<Record<string, EvalTrialLive>> }) {
  const active = Object.values(trials);
  if (active.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary}>Active eval trials</Text>
      {active.map((trial) => (
        <Text key={`${trial.task}-${trial.trial}`}>
          {`  ${trial.task} ${trial.trial}/${trial.k} · `}
          <Text color={theme.muted}>
            {trial.requiresAuth ? 'headed auth' : 'headless'} · {trial.status}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
