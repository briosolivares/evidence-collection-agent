import { Box, Text } from 'ink';

import type { ArtifactRole } from '../../run/artifacts.js';
import { formatBytes } from '../format.js';
import type { PublishedArtifact } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

/** Human label for one manifest role (an artifact may hold both). */
const ROLE_LABELS = {
  requested_output: 'requested output',
  evidence: 'evidence',
} as const;

/** Human labels for an artifact's roles, ` · `-joined — shared by the
 * detail card and the completion item's artifact digest lines. */
export function describeRoles(roles: readonly ArtifactRole[]): string {
  return roles.map((role) => ROLE_LABELS[role]).join(' · ');
}

interface ArtifactDetailProps {
  /** The published artifact whose provenance the card shows. */
  artifact: PublishedArtifact;
}

/**
 * One published artifact's full provenance — the detail card behind Enter
 * on an artifact row (the live rail now; the completion panel and /runs
 * later). Purely presentational: props in, no store access, no input —
 * whichever surface mounts it owns the keys its hint line advertises.
 * Each row nests its spans inside a single <Text> so long values (the
 * full sha256 especially — never truncated) wrap as one paragraph instead
 * of overflowing narrow terminals.
 */
export function ArtifactDetail({ artifact }: ArtifactDetailProps) {
  const { entry, sizeBytes } = artifact;
  const roles = describeRoles(entry.roles ?? []);
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.emphasis}>{`  ${glyphs.evidence} `}</Text>
        <Text bold>{entry.filename}</Text>
        {roles !== '' && <Text color={theme.muted}>{`  ${roles}`}</Text>}
      </Text>
      {entry.sourceUrl !== undefined && (
        <Text color={theme.muted}>{`  ${glyphs.source} source: ${entry.sourceUrl}`}</Text>
      )}
      <Text color={theme.muted}>{`  captured: ${localTime(entry.capturedAt)}`}</Text>
      <Text color={theme.muted}>{`  sha256: ${entry.sha256}`}</Text>
      <Text color={theme.muted}>
        {`  ${sizeBytes === undefined ? '?' : formatBytes(sizeBytes)} on disk`}
      </Text>
      <Text color={theme.muted}>  space preview · o open · r reveal · esc back</Text>
    </Box>
  );
}

/** capturedAt is ISO UTC; the card shows the viewer's local time. */
function localTime(capturedAt: string): string {
  const parsed = new Date(capturedAt);
  return Number.isNaN(parsed.getTime()) ? capturedAt : parsed.toLocaleString();
}
