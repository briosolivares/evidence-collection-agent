import { Box, Text } from 'ink';

import type { SherlockConfig } from '../config.js';
import type { RunChecklistSnapshot } from '../hooks/useRunChecklist.js';
import type { LiveRunState } from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { StatusLine } from './StatusLine.js';

interface LiveRegionProps {
  config: SherlockConfig;
  live: LiveRunState;
  checklist: RunChecklistSnapshot;
  cancelling?: boolean;
  now?: () => number;
  rng?: () => number;
}

/**
 * The dynamic region below the transcript: streaming prose, pending tool
 * lines, and the animated status line. Everything here is mutable —
 * content moves into <Static> only once finalized by the reducer.
 */
export function LiveRegion({ config, live, checklist, cancelling, now, rng }: LiveRegionProps) {
  return (
    <Box flexDirection="column">
      {live.streamingText !== '' && (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{live.streamingText}</Text>
        </Box>
      )}
      {live.pendingTools.map((pending) => (
        <Box key={pending.id} marginTop={1} paddingLeft={1}>
          <Text>
            <Text color={pending.isEvidence ? theme.emphasis : theme.activity}>
              {`${pending.isEvidence ? glyphs.evidence : glyphs.activity} `}
            </Text>
            <Text>{pending.line}</Text>
            <Text color={theme.muted}>{'…'}</Text>
          </Text>
        </Box>
      ))}
      <StatusLine
        config={config}
        live={live}
        checklist={checklist}
        cancelling={cancelling}
        now={now}
        rng={rng}
      />
    </Box>
  );
}
