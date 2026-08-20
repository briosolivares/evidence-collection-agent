import { Box, Text } from 'ink';

import { formatBytes, formatDuration, formatTokens } from '../format.js';
import type { TranscriptItem } from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { describeRoles } from './ArtifactDetail.js';
import { WelcomeCard } from './WelcomeCard.js';

/**
 * Render one finalized transcript item. Items are immutable by the time
 * they reach <Static>, so this component renders each exactly once.
 * Raw input/result detail renders only in verbose mode (R5).
 */
export function TranscriptItemView({
  item,
  verbose = false,
}: {
  item: TranscriptItem;
  verbose?: boolean;
}) {
  switch (item.kind) {
    case 'banner':
      return <WelcomeCard apiKeyPresent={item.apiKeyPresent} identity={item.identity} />;
    case 'user_task':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text>
            <Text color={theme.primary}>{`${glyphs.user} `}</Text>
            <Text bold>{item.text}</Text>
          </Text>
        </Box>
      );
    case 'agent_text':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'activity':
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text>
            <Text color={theme.activity}>{`${glyphs.activity} `}</Text>
            <Text>{item.line}</Text>
            <Text color={statusColor(item.status)}>{`  ${statusGlyph(item.status)}`}</Text>
          </Text>
          {verbose && item.verbose !== undefined && <VerboseDetail verbose={item.verbose} />}
        </Box>
      );
    case 'evidence':
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text>
            <Text color={theme.emphasis}>{`${glyphs.evidence} `}</Text>
            <Text color={theme.emphasis}>{item.line}</Text>
          </Text>
          {item.sourceUrl !== undefined && (
            <Text color={theme.muted}>{`  ${glyphs.source} source: ${item.sourceUrl}`}</Text>
          )}
          {verbose && item.verbose !== undefined && <VerboseDetail verbose={item.verbose} />}
        </Box>
      );
    case 'completion':
      return (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Box>
            <Text color={item.outcome === 'complete' ? theme.success : theme.error}>
              {`${item.outcome === 'complete' ? glyphs.success : glyphs.error} `}
            </Text>
            <Text>
              {item.outcome === 'complete'
                ? `${item.verb} in ${formatDuration(item.elapsedMs)} · ${formatTokens(item.tokens)}`
                : `Incomplete after ${formatDuration(item.elapsedMs)} · ${formatTokens(item.tokens)}`}
            </Text>
          </Box>
          {item.artifacts.map((artifact) => (
            <Text key={artifact.filename}>
              <Text color={theme.emphasis}>{`  ${glyphs.evidence} `}</Text>
              <Text>{artifact.filename}</Text>
              <Text color={theme.muted}>
                {` · ${artifact.sizeBytes === undefined ? '?' : formatBytes(artifact.sizeBytes)}` +
                  (artifact.roles.length > 0 ? ` · ${describeRoles(artifact.roles)}` : '')}
              </Text>
            </Text>
          ))}
          <Text color={theme.muted}>{`  ${item.runDir}`}</Text>
        </Box>
      );
    case 'cancelled':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={theme.error}>{`${glyphs.error} `}</Text>
          <Text>
            {`Interrupted after ${formatDuration(item.elapsedMs)} · ${formatTokens(item.tokens)}`}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={theme.error}>{`${glyphs.error} ${item.message}`}</Text>
        </Box>
      );
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={theme.muted}>{item.text}</Text>
        </Box>
      );
    case 'eval_trial':
      return <EvalTrial item={item} />;
    case 'eval_report':
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}

function statusGlyph(status: 'ok' | 'error' | 'retried'): string {
  if (status === 'ok') return glyphs.success;
  if (status === 'error') return glyphs.error;
  return `${glyphs.retried} retried`;
}

function statusColor(status: 'ok' | 'error' | 'retried'): string {
  if (status === 'ok') return theme.success;
  if (status === 'error') return theme.error;
  return theme.muted;
}

function VerboseDetail({ verbose }: { verbose: { input: string; result: string } }) {
  return (
    <Box flexDirection="column" marginLeft={4}>
      <Text color={theme.muted} dimColor>{`input: ${verbose.input}`}</Text>
      <Text color={theme.muted} dimColor>{`result: ${verbose.result}`}</Text>
    </Box>
  );
}

function EvalTrial({ item }: { item: Extract<TranscriptItem, { kind: 'eval_trial' }> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text
        color={theme.muted}
      >{`— ${item.task} · trial ${item.trial}/${item.k} · ${formatDuration(item.elapsedMs)} —`}</Text>
      {item.assertions.map((assertion) => (
        <Text key={assertion.name}>
          <Text color={assertion.passed ? theme.success : theme.error}>
            {`  ${assertion.passed ? glyphs.success : glyphs.error} ${assertion.name}`}
          </Text>
          {!assertion.passed && assertion.detail !== undefined && (
            <Text color={theme.muted}>{` — ${assertion.detail}`}</Text>
          )}
        </Text>
      ))}
    </Box>
  );
}
