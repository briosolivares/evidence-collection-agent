import { Box, Text } from 'ink';

import type { EvalsLiveRegionProps } from '../bridge/evalsFeature.js';
import { theme } from '../theme.js';

export function EvalsLiveRegion({ trials }: EvalsLiveRegionProps) {
  const active = Object.values(trials);
  if (active.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary}>Active eval trials</Text>
      {active.map((trial) => (
        <Text key={`${trial.task}-${trial.trial}`}>
          {`  ${trial.task} ${trial.trial}/${trial.k} · `}
          <Text color={theme.muted}>
            {trial.headed ? 'headed' : 'headless'} · {trial.status}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
