import { Box, Text } from 'ink';

import { formatDuration, formatTokens } from '../format.js';
import type { TranscriptItem } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

/**
 * Render one finalized transcript item. Items are immutable by the time
 * they reach <Static>, so this component renders each exactly once.
 */
export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'banner':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.primary} bold>
              {`${glyphs.spinnerFrames[2]} Sherlock`}
            </Text>
            <Text color={theme.muted}> — evidence collection agent</Text>
          </Box>
          {!item.apiKeyPresent && (
            <Text color={theme.error}>
              {`${glyphs.retried} ANTHROPIC_API_KEY is not set — investigations will fail until it is configured.`}
            </Text>
          )}
        </Box>
      );
    case 'user_task':
      return (
        <Box marginTop={1}>
          <Text color={theme.primary}>{`${glyphs.user} `}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'agent_text':
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'activity':
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.activity}>{`${glyphs.activity} `}</Text>
            <Text>{item.line}</Text>
            <Text color={statusColor(item.status)}>{`  ${statusGlyph(item.status)}`}</Text>
          </Box>
          {item.verbose !== undefined && <VerboseDetail verbose={item.verbose} />}
        </Box>
      );
    case 'evidence':
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.emphasis}>{`${glyphs.evidence} `}</Text>
            <Text color={theme.emphasis}>{item.line}</Text>
          </Box>
          {item.sourceUrl !== undefined && (
            <Text color={theme.muted}>{`  ${glyphs.source} source: ${item.sourceUrl}`}</Text>
          )}
          {item.verbose !== undefined && <VerboseDetail verbose={item.verbose} />}
        </Box>
      );
    case 'completion':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={theme.success}>{`${glyphs.success} `}</Text>
            <Text>
              {`${item.verb} in ${formatDuration(item.elapsedMs)} · ${formatTokens(item.tokens)}`}
            </Text>
          </Box>
          <Text color={theme.muted}>{`  ${item.runDir}`}</Text>
        </Box>
      );
    case 'cancelled':
      return (
        <Box marginTop={1}>
          <Text color={theme.error}>{`${glyphs.error} `}</Text>
          <Text>
            {`Interrupted after ${formatDuration(item.elapsedMs)} · ${formatTokens(item.tokens)}`}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={theme.error}>{`${glyphs.error} ${item.message}`}</Text>
        </Box>
      );
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={theme.muted}>{item.text}</Text>
        </Box>
      );
    case 'run_summary':
      return <RunSummary item={item} />;
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

function RunSummary({ item }: { item: Extract<TranscriptItem, { kind: 'run_summary' }> }) {
  const { manifest, metrics } = item;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.primary}>{`${glyphs.user} `}</Text>
        <Text bold>{manifest.task}</Text>
      </Box>
      <Text color={theme.muted}>{`  started ${manifest.startedAt}`}</Text>
      {metrics !== undefined && (
        <Text color={theme.muted}>
          {`  ${metrics.status} · ${metrics.turns} turns · ${formatTokens(metrics.totalTokens)} · ${formatDuration(metrics.wallClockMs)}`}
        </Text>
      )}
      {manifest.artifacts.length === 0 ? (
        <Text color={theme.muted}>  no artifacts</Text>
      ) : (
        manifest.artifacts.map((artifact) => (
          <Text key={artifact.filename}>
            <Text color={theme.emphasis}>{`  ${glyphs.evidence} ${artifact.filename}`}</Text>
            <Text color={theme.muted}>
              {`  ${artifact.sizeBytes === undefined ? '?' : formatBytes(artifact.sizeBytes)} · sha256 ${artifact.sha256Prefix}`}
            </Text>
          </Text>
        ))
      )}
      <Text color={theme.muted}>{`  ${item.runDir}`}</Text>
    </Box>
  );
}

function EvalTrial({ item }: { item: Extract<TranscriptItem, { kind: 'eval_trial' }> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted}>{`— ${item.task} · trial ${item.trial}/${item.k} · ${formatDuration(item.elapsedMs)} —`}</Text>
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
