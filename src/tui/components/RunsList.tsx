import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';

import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  formatTokens,
  truncate,
} from '../format.js';
import { loadRunSummary, type RunListEntry } from '../runScanner.js';
import type { ManifestView, MetricsView } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

const TASK_SNIPPET_MAX = 48;

/** What loadRunSummary yields for one run — injectable for tests. */
export type RunSummaryView = { manifest: ManifestView; metrics?: MetricsView };

interface RunsListProps {
  /** Entries newest first (from scanRuns). */
  entries: readonly RunListEntry[];
  /** Called on Esc from the list level (closes the overlay). */
  onClose: () => void;
  /** Loads one run's summary for the detail level; defaults to the real
   * scanner so tests can inject fixtures. */
  loadSummary?: (runDir: string) => RunSummaryView;
  /** Visible window size for long lists. */
  limit?: number;
  /** Injectable clock for relative dates. */
  now?: () => number;
}

function statusGlyph(status: RunListEntry['status']): { glyph: string; color: string } {
  switch (status) {
    case 'complete':
      return { glyph: glyphs.success, color: theme.success };
    case 'unfinished':
      return { glyph: '◐', color: theme.muted };
    case 'stopped':
      return { glyph: glyphs.error, color: theme.error };
  }
}

/**
 * The /runs overlay: a two-level, arrow-navigable browser (R2). The list
 * level scrolls past runs (↑/↓ move, Enter or → opens the highlighted
 * run's detail, Esc closes); the detail level renders that run's summary
 * inside the overlay (↑/↓ jump to the previous/next run's detail, ← or
 * Esc returns to the list with the cursor preserved). Summary-load
 * failures render inside the detail level, never in the transcript.
 */
export function RunsList({
  entries,
  onClose,
  loadSummary = loadRunSummary,
  limit = 8,
  now = Date.now,
}: RunsListProps) {
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (view === 'detail') {
      if (key.leftArrow || key.escape) {
        setView('list');
        return;
      }
      if (key.upArrow) {
        setCursor((current) => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setCursor((current) => Math.min(entries.length - 1, current + 1));
      }
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (entries.length === 0) return;
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
    } else if (key.downArrow) {
      setCursor((current) => Math.min(entries.length - 1, current + 1));
    } else if (key.return || key.rightArrow) {
      setView('detail');
    }
  });

  const detailEntry = view === 'detail' ? entries[cursor] : undefined;
  const detail = useMemo(() => {
    if (detailEntry === undefined) return undefined;
    try {
      return { summary: loadSummary(detailEntry.runDir) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [detailEntry, loadSummary]);

  if (detailEntry !== undefined && detail !== undefined) {
    return (
      <RunDetail entry={detailEntry} detail={detail} position={`${cursor + 1}/${entries.length}`} />
    );
  }

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(limit / 2), entries.length - limit));
  const visible = entries.slice(windowStart, windowStart + limit);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Past runs
      </Text>
      {entries.length === 0 ? (
        <Text color={theme.muted}>{'  No runs yet — type a task to start one.'}</Text>
      ) : (
        visible.map((entry, index) => {
          const absolute = windowStart + index;
          const selected = absolute === cursor;
          const { glyph, color } = statusGlyph(entry.status);
          const started = Date.parse(entry.startedAt);
          const when = Number.isNaN(started) ? '?' : formatRelativeTime(started, now());
          return (
            <Text key={entry.id}>
              <Text color={selected ? theme.emphasis : undefined}>{selected ? '› ' : '  '}</Text>
              <Text color={color}>{`${glyph} `}</Text>
              <Text color={selected ? theme.emphasis : undefined}>
                {truncate(entry.task, TASK_SNIPPET_MAX)}
              </Text>
              <Text color={theme.muted}>{`  ${when}`}</Text>
            </Text>
          );
        })
      )}
      {entries.length > limit && (
        <Text color={theme.muted}>{`  ${cursor + 1}/${entries.length}`}</Text>
      )}
      <Text color={theme.muted}>{'  ↑↓ select · enter view · esc close'}</Text>
    </Box>
  );
}

/** The detail level: one run's summary (or its load error), in-overlay. */
function RunDetail({
  entry,
  detail,
  position,
}: {
  entry: RunListEntry;
  detail: { summary?: RunSummaryView; error?: string };
  position: string;
}) {
  const { glyph, color } = statusGlyph(entry.status);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.primary} bold>
          Past runs
        </Text>
        <Text color={theme.muted}>{` · run ${position}`}</Text>
      </Text>
      {detail.summary === undefined ? (
        <Text color={theme.error}>
          {`  ${glyphs.error} Couldn't read this run: ${detail.error ?? 'unknown error'}`}
        </Text>
      ) : (
        <RunSummaryBody glyph={glyph} glyphColor={color} summary={detail.summary} />
      )}
      <Text color={theme.muted}>{`  ${entry.runDir}`}</Text>
      <Text color={theme.muted}> ↑↓ prev/next run · ← back · esc back</Text>
    </Box>
  );
}

function RunSummaryBody({
  glyph,
  glyphColor,
  summary,
}: {
  glyph: string;
  glyphColor: string;
  summary: RunSummaryView;
}) {
  const { manifest, metrics } = summary;
  return (
    <>
      <Text>
        <Text color={glyphColor}>{`  ${glyph} `}</Text>
        <Text bold>{manifest.task}</Text>
      </Text>
      <Text color={theme.muted}>{`  started ${manifest.startedAt}`}</Text>
      {metrics !== undefined && (
        <Text color={theme.muted}>
          {`  ${metrics.status} · ${metrics.turns} turns · ${formatTokens(metrics.totalTokens)} · ${formatDuration(metrics.wallClockMs)}`}
        </Text>
      )}
      {manifest.artifacts.length === 0 ? (
        <Text color={theme.muted}> no artifacts</Text>
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
    </>
  );
}
