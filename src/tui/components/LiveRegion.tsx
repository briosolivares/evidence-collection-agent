import { Box, Text } from 'ink';

import type { LiveRunState } from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { StatusLine } from './StatusLine.js';

interface LiveRegionProps {
  live: LiveRunState;
  cancelling?: boolean;
  now?: () => number;
  rng?: () => number;
}

/**
 * The dynamic region below the transcript: streaming prose, pending tool
 * lines, and the animated status line. Everything here is mutable —
 * content moves into <Static> only once finalized by the reducer.
 */
export function LiveRegion({ live, cancelling, now, rng }: LiveRegionProps) {
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
      <StatusLine live={live} cancelling={cancelling} now={now} rng={rng} />
    </Box>
  );
}
