// The shared halves of an interactive artifact list: the windowed row
// renderer and the ↑↓/Enter/Space/o/r key handler. The live ArtifactRail
// and the completion ArtifactsPanel compose both around their own chrome
// (header, hints, detail placement); each surface passes the artifacts in
// its own display order, and the reducer-owned cursor indexes into that
// order. Esc is deliberately handled by neither — App's global handler
// owns it and consults the reducer's artifact substate, so close-detail
// precedence is decided in exactly one place.

import { Box, Text, useInput } from 'ink';

import { formatBytes } from '../format.js';
import {
  openPath,
  quickLookPath,
  revealPath,
  type OpenExternalResult,
} from '../openExternal.js';
import { isHelperProposalArtifact, type UiAction } from '../store/reducer.js';
import type { ArtifactUiState, PublishedArtifact } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

/** One injectable open/reveal/preview helper (the openExternal contract:
 * always resolves to a result, never throws or rejects). */
export type ExternalAction = (absPath: string) => Promise<OpenExternalResult>;

export interface ArtifactKeyOptions {
  /** Artifacts in display order — `ui.cursor` indexes into this list. */
  artifacts: readonly PublishedArtifact[];
  /** Reducer-owned selection state (design decision 3). */
  ui: ArtifactUiState;
  /** Absolute run dir the artifact paths resolve against. */
  runDir?: string;
  /** Dispatch into the session store (navigation, detail, notices). */
  dispatch: (action: UiAction) => void;
  /** Injectable external-open seams; defaults are the real helpers. */
  open?: ExternalAction;
  reveal?: ExternalAction;
  preview?: ExternalAction;
  /** Ink useInput gate — false while the surface is not focused. */
  isActive?: boolean;
}

/**
 * The artifact list's key handler: ↑↓ move, Enter opens the highlighted
 * artifact's provenance card, Space/o/r preview/open/reveal it from
 * either view. External opens are fire-and-forget — the helpers never
 * reject (they resolve { ok: false, message } instead), so no unhandled
 * rejection can escape; a failure renders as a notice line, never a
 * crash.
 */
export function useArtifactKeys({
  artifacts,
  ui,
  runDir,
  dispatch,
  open = openPath,
  reveal = revealPath,
  preview = quickLookPath,
  isActive = true,
}: ArtifactKeyOptions): void {
  const launch = (action: ExternalAction) => {
    const artifact = artifacts[ui.cursor];
    if (artifact === undefined) return;
    if (runDir === undefined) {
      dispatch({
        type: 'notice',
        text: 'The run directory is not known yet — try again in a moment.',
      });
      return;
    }
    void action(`${runDir}/${artifact.entry.filename}`).then((result) => {
      if (!result.ok) dispatch({ type: 'notice', text: result.message });
    });
  };

  useInput(
    (input, key) => {
      // Space/o/r act on the highlighted artifact from both views.
      if (input === ' ') {
        launch(preview);
        return;
      }
      if (input === 'o') {
        launch(open);
        return;
      }
      if (input === 'r') {
        launch(reveal);
        return;
      }
      // Arrows/Enter are rows-level keys; the detail card advertises none.
      if (ui.view === 'detail') return;
      if (key.upArrow) dispatch({ type: 'artifact_nav', delta: -1 });
      else if (key.downArrow) dispatch({ type: 'artifact_nav', delta: 1 });
      else if (key.return) dispatch({ type: 'artifact_open_detail' });
    },
    { isActive },
  );
}

interface ArtifactRowsProps {
  /** Artifacts in display order, matching the key handler's list. */
  artifacts: readonly PublishedArtifact[];
  /** The highlighted index; also anchors the visible window. */
  cursor: number;
  /** False renders the rows passively — no `› ` selection marker, and
   * the overflow line counts artifacts instead of naming a position. */
  showCursor?: boolean;
  /** Visible window size for long lists. */
  limit?: number;
  /** A completed, verified run may contain reviewable helper proposals.
   * They stay ordinary evidence artifacts, but the design requires the TUI
   * to distinguish them from requested outputs. Live/incomplete runs leave
   * this false because a proposal is not review-ready until verification. */
  showVerifiedHelperProposals?: boolean;
}

/** The windowed artifact rows (house list idiom: `› ` + emphasis on the
 * selected row, filename + size, RunsList-style windowing). */
export function ArtifactRows({
  artifacts,
  cursor,
  showCursor = true,
  limit = 8,
  showVerifiedHelperProposals = false,
}: ArtifactRowsProps) {
  const windowStart = Math.max(
    0,
    Math.min(cursor - Math.floor(limit / 2), artifacts.length - limit),
  );
  const visible = artifacts.slice(windowStart, windowStart + limit);

  return (
    <Box flexDirection="column">
      {visible.map((artifact, index) => {
        const absolute = windowStart + index;
        const selected = showCursor && absolute === cursor;
        const beginsVisibleProposalGroup =
          showVerifiedHelperProposals &&
          isHelperProposalArtifact(artifact) &&
          (index === 0 || !isHelperProposalArtifact(visible[index - 1]!));
        return (
          <Box key={artifact.entry.filename} flexDirection="column">
            {beginsVisibleProposalGroup && (
              <Text color={theme.primary} bold>
                Verified helper proposals
              </Text>
            )}
            <Text>
              <Text color={selected ? theme.emphasis : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={theme.emphasis}>{`${glyphs.evidence} `}</Text>
              <Text color={selected ? theme.emphasis : undefined}>
                {artifact.entry.filename}
              </Text>
              <Text color={theme.muted}>
                {`  ${artifact.sizeBytes === undefined ? '?' : formatBytes(artifact.sizeBytes)}`}
              </Text>
            </Text>
          </Box>
        );
      })}
      {artifacts.length > limit && (
        <Text color={theme.muted}>
          {showCursor
            ? `  ${cursor + 1}/${artifacts.length}`
            : `  ${artifacts.length} artifacts`}
        </Text>
      )}
    </Box>
  );
}
