import { Box, Text } from 'ink';

import type { UiAction } from '../store/reducer.js';
import type { ArtifactUiState, PublishedArtifact } from '../store/state.js';
import { theme } from '../theme.js';
import { ArtifactDetail } from './ArtifactDetail.js';
import { ArtifactRows, useArtifactKeys, type ExternalAction } from './ArtifactRows.js';

interface ArtifactRailProps {
  /** Published artifacts in publish order (state.artifacts verbatim —
   * the rail is the chronological log; requested-outputs-first ordering
   * belongs to the completion summary). */
  artifacts: readonly PublishedArtifact[];
  /** Reducer-owned selection state (design decision 3) — unlike RunsList
   * the rail keeps no view state of its own, so App's Esc handler can
   * consult it. */
  ui: ArtifactUiState;
  /** Absolute run dir once tracing captures it. Artifacts only publish
   * after the first tool exec, which follows the run_dir event, so it is
   * realistically always known by the time a row exists. */
  runDir?: string;
  /** Dispatch into the session store (navigation, detail, notices). */
  dispatch: (action: UiAction) => void;
  /** Injectable external-open seams; defaults are the real helpers. */
  open?: ExternalAction;
  reveal?: ExternalAction;
  preview?: ExternalAction;
  /** Visible window size for long lists. */
  limit?: number;
  /** False while another surface owns the keys mid-run (the question
   * dialog): rows stay visible, the keymap goes inert — Ink broadcasts
   * every keypress to every mounted useInput, so two live handlers on
   * the same keys would both fire. */
  active?: boolean;
  /** Tab gives the rail focus; otherwise it remains a passive live list. */
  focused?: boolean;
}

/**
 * The live artifact rail: published artifacts as selectable rows the
 * moment they land, rendered below the live region while a run streams.
 * Keys (via useArtifactKeys) are all dead while running — the composer is
 * unmounted — so its useInput conflicts with nothing except the question
 * dialog, which App resolves by flipping `active` off while one is open.
 * Esc is deliberately
 * *not* handled here: App's global handler owns it and consults the
 * reducer's artifact substate, so closing an open detail card wins over
 * cancelling the run — a second Esc listener here would race that same
 * keypress.
 *
 * App mounts the rail for the whole run and it renders nothing until the
 * first artifact lands. Mounting on the first publish instead would
 * register useInput from a dispatch outside any input event, and React
 * defers that passive-effect flush — a keypress arriving before the
 * flush would be dropped. Mounted at run start (a keyboard-driven,
 * discrete update) the subscription is live before any key can follow.
 */
export function ArtifactRail({
  artifacts,
  ui,
  runDir,
  dispatch,
  open,
  reveal,
  preview,
  active = true,
  focused,
  limit = 8,
}: ArtifactRailProps) {
  const isFocused = focused ?? true;
  useArtifactKeys({
    artifacts,
    ui,
    runDir,
    dispatch,
    open,
    reveal,
    preview,
    isActive: active,
  });

  // Nothing published yet: keep the input hook alive, draw nothing.
  if (artifacts.length === 0) return null;

  const current = artifacts[ui.cursor];
  if (isFocused && ui.view === 'detail' && current !== undefined) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={theme.primary} bold>
            Artifacts
          </Text>
          <Text color={theme.muted}>{` · ${ui.cursor + 1}/${artifacts.length}`}</Text>
        </Text>
        <ArtifactDetail artifact={current} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Artifacts
      </Text>
      <ArtifactRows artifacts={artifacts} cursor={ui.cursor} limit={limit} showCursor={isFocused} />
      <Text color={theme.muted}>
        {isFocused
          ? '  ↑↓ select · enter details · space preview · o open · r reveal'
          : '  tab to browse'}
      </Text>
    </Box>
  );
}
