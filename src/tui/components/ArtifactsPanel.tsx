import { Box, Text } from 'ink';

import { formatDuration, formatTokens, truncate } from '../format.js';
import { orderArtifactsForSummary, type UiAction } from '../store/reducer.js';
import type {
  ArtifactUiState,
  CompletedRunSummary,
  PublishedArtifact,
} from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { ArtifactDetail } from './ArtifactDetail.js';
import { ArtifactRows, useArtifactKeys, type ExternalAction } from './ArtifactRows.js';

/** The answer block's clamp: a few source lines, never a wall of prose
 * (the full text is already in the transcript as agent_text). */
const ANSWER_MAX_LINES = 3;
const ANSWER_MAX_CHARS = 280;

interface ArtifactsPanelProps {
  /** The completed run the panel summarizes (header + answer data).
   * Absent when /artifacts reopens artifacts retained from a run that
   * recorded no summary (cancelled / budget-exceeded): the panel then
   * renders an artifacts-only header and no answer block. */
  summary?: CompletedRunSummary;
  /** Published artifacts in publish order (state.artifacts verbatim);
   * the panel reorders them requested-outputs-first itself. */
  artifacts: readonly PublishedArtifact[];
  /** Reducer-owned selection state, shared with the rail. */
  ui: ArtifactUiState;
  /** True while mode === 'artifacts': the panel owns ↑↓/Enter/Space/o/r
   * and shows its selection; false renders it passively above the
   * focused composer. */
  focused: boolean;
  /** Absolute run dir the artifact rows open files against. */
  runDir?: string;
  /** Dispatch into the session store (navigation, detail, notices). */
  dispatch: (action: UiAction) => void;
  /** Injectable external-open seams; defaults are the real helpers. */
  open?: ExternalAction;
  reveal?: ExternalAction;
  preview?: ExternalAction;
  /** Visible window size for long lists. */
  limit?: number;
}

/**
 * The completion summary panel: rendered above the composer once a run
 * completes — the ✓ header (matching the transcript's completion line),
 * a concise answer block, and the published artifacts with requested
 * outputs first. It renders passively (design decision 4 — no forced
 * Esc after a run; the composer keeps focus and the next task types
 * immediately); Tab hands it the keys, where selection, the detail
 * card, and Space/o/r behave exactly as in the live rail. Esc and Tab
 * are App's keys, as everywhere. /artifacts re-renders it focused for
 * the most recent run — with or without a completion summary.
 */
export function ArtifactsPanel({
  summary,
  artifacts,
  ui,
  focused,
  runDir,
  dispatch,
  open,
  reveal,
  preview,
  limit = 8,
}: ArtifactsPanelProps) {
  const ordered = orderArtifactsForSummary(artifacts);
  useArtifactKeys({
    artifacts: ordered,
    ui,
    runDir,
    dispatch,
    open,
    reveal,
    preview,
    isActive: focused,
  });

  const current = ordered[ui.cursor];
  const detailOpen = focused && ui.view === 'detail' && current !== undefined;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {summary !== undefined ? (
        <>
          <Box>
            <Text color={theme.success}>{`${glyphs.success} `}</Text>
            <Text>
              {`${summary.verb} in ${formatDuration(summary.elapsedMs)} · ${formatTokens(summary.tokens)}`}
            </Text>
          </Box>
          <Text color={theme.muted}>{`  ${summary.runDir}`}</Text>
          <Box paddingLeft={2} marginBottom={ordered.length > 0 ? 1 : 0}>
            <Text>{clampAnswer(summary.finalText)}</Text>
          </Box>
        </>
      ) : (
        <>
          {/* Artifacts-only header: what survived a run that recorded
              no completion summary. */}
          <Text>
            <Text color={theme.primary} bold>
              Artifacts
            </Text>
            {detailOpen && (
              <Text color={theme.muted}>{` · ${ui.cursor + 1}/${ordered.length}`}</Text>
            )}
          </Text>
          {runDir !== undefined && <Text color={theme.muted}>{`  ${runDir}`}</Text>}
        </>
      )}
      {detailOpen && current !== undefined ? (
        <>
          {summary !== undefined && (
            <Text>
              <Text color={theme.primary} bold>
                Artifacts
              </Text>
              <Text color={theme.muted}>{` · ${ui.cursor + 1}/${ordered.length}`}</Text>
            </Text>
          )}
          <ArtifactDetail artifact={current} />
        </>
      ) : (
        ordered.length > 0 && (
          <>
            <ArtifactRows
              artifacts={ordered}
              cursor={focused ? ui.cursor : 0}
              showCursor={focused}
              limit={limit}
            />
            <Text color={theme.muted}>
              {focused
                ? '  ↑↓ select · enter details · space preview · o open · r reveal · esc done'
                : '  tab to browse artifacts'}
            </Text>
          </>
        )
      )}
    </Box>
  );
}

/** The concise answer: trimmed, clamped, "Task completed" when empty. */
function clampAnswer(finalText: string | undefined): string {
  const text = (finalText ?? '').trim();
  if (text === '') return 'Task completed';
  const lines = truncate(text, ANSWER_MAX_CHARS).split('\n');
  if (lines.length <= ANSWER_MAX_LINES) return lines.join('\n');
  return `${lines.slice(0, ANSWER_MAX_LINES).join('\n')}\n…`;
}
