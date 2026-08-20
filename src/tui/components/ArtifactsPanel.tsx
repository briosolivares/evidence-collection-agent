import { Box, Text } from 'ink';

import { formatDuration, formatTokens, truncate } from '../format.js';
import { NO_COMPLETION_REPORT_TEXT } from '../../run/runOutcome.js';
import { orderArtifactsForSummary, type UiAction } from '../store/reducer.js';
import type { ArtifactUiState, CompletedRunSummary, PublishedArtifact } from '../store/state.js';
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
 * The terminal summary panel: rendered above the composer once a run ends
 * verified or incomplete — its status header, concise worker response,
 * unresolved requirements when present, and published artifacts with
 * requested outputs first. It renders passively (design decision 4 — no forced
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
            <Text color={summary.outcome === 'complete' ? theme.success : theme.error}>
              {`${summary.outcome === 'complete' ? glyphs.success : glyphs.error} `}
            </Text>
            <Text>
              {summary.outcome === 'complete'
                ? `${summary.verb} in ${formatDuration(summary.elapsedMs)} · ${formatTokens(summary.tokens)}`
                : `Incomplete after ${formatDuration(summary.elapsedMs)} · ${formatTokens(summary.tokens)}`}
            </Text>
          </Box>
          <Text color={theme.muted}>{`  ${summary.runDir}`}</Text>
          <Box paddingLeft={2} marginBottom={ordered.length > 0 ? 1 : 0}>
            <Text>{clampAnswer(summary.finalText, summary.outcome)}</Text>
          </Box>
          {summary.outcome === 'incomplete' && summary.unresolved.length > 0 && (
            <Box flexDirection="column" paddingLeft={2} marginBottom={ordered.length > 0 ? 1 : 0}>
              <Text color={theme.primary} bold>
                Unresolved
              </Text>
              {summary.unresolved.map((item, index) => (
                <Text key={`${item.requirement}-${index}`}>
                  {`  • ${truncate(item.requirement, 120)} — ${truncate(item.reason, 180)}`}
                </Text>
              ))}
            </Box>
          )}
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
              showVerifiedHelperProposals={summary?.outcome === 'complete'}
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

/** The concise answer with truthful deterministic fallbacks. */
function clampAnswer(
  finalText: string | undefined,
  outcome: CompletedRunSummary['outcome'],
): string {
  const text = (finalText ?? '').trim();
  if (text === '') {
    return outcome === 'complete' ? 'Task completed' : NO_COMPLETION_REPORT_TEXT;
  }
  const lines = truncate(text, ANSWER_MAX_CHARS).split('\n');
  if (lines.length <= ANSWER_MAX_LINES) return lines.join('\n');
  return `${lines.slice(0, ANSWER_MAX_LINES).join('\n')}\n…`;
}
