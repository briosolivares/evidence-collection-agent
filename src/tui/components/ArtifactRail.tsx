import { Box, Text, useInput } from 'ink';

import { formatBytes } from '../format.js';
import {
  openPath,
  quickLookPath,
  revealPath,
  type OpenExternalResult,
} from '../openExternal.js';
import type { UiAction } from '../store/reducer.js';
import type { ArtifactUiState, PublishedArtifact } from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { ArtifactDetail } from './ArtifactDetail.js';

/** One injectable open/reveal/preview helper (the openExternal contract:
 * always resolves to a result, never throws or rejects). */
type ExternalAction = (absPath: string) => Promise<OpenExternalResult>;

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
}

/**
 * The live artifact rail: published artifacts as selectable rows the
 * moment they land, rendered below the live region while a run streams.
 * ↑↓ move, Enter opens the highlighted artifact's provenance card,
 * Space/o/r preview/open/reveal it from either view. ↑↓/Enter/Space/o/r
 * are all dead keys while running (the composer is unmounted), so this
 * useInput conflicts with nothing. Esc is deliberately *not* handled
 * here: App's global handler owns it and consults the reducer's artifact
 * substate, so closing an open detail card wins over cancelling the run
 * — a second Esc listener here would race that same keypress.
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
  open = openPath,
  reveal = revealPath,
  preview = quickLookPath,
  limit = 8,
}: ArtifactRailProps) {
  // Fire-and-forget an external open on the highlighted artifact. The
  // helpers never reject (they resolve { ok: false, message } instead),
  // so no unhandled rejection can escape; a failure renders as a notice
  // line, never a crash.
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

  useInput((input, key) => {
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
  });

  // Nothing published yet: keep the input hook alive, draw nothing.
  if (artifacts.length === 0) return null;

  const current = artifacts[ui.cursor];
  if (ui.view === 'detail' && current !== undefined) {
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

  const windowStart = Math.max(
    0,
    Math.min(ui.cursor - Math.floor(limit / 2), artifacts.length - limit),
  );
  const visible = artifacts.slice(windowStart, windowStart + limit);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Artifacts
      </Text>
      {visible.map((artifact, index) => {
        const absolute = windowStart + index;
        const selected = absolute === ui.cursor;
        return (
          <Text key={artifact.entry.filename}>
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
        );
      })}
      {artifacts.length > limit && (
        <Text color={theme.muted}>{`  ${ui.cursor + 1}/${artifacts.length}`}</Text>
      )}
      <Text color={theme.muted}>
        {'  ↑↓ select · enter details · space preview · o open · r reveal'}
      </Text>
    </Box>
  );
}
