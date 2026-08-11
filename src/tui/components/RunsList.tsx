import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { formatRelativeTime, truncate } from '../format.js';
import type { RunListEntry } from '../runScanner.js';
import { glyphs, theme } from '../theme.js';

const TASK_SNIPPET_MAX = 48;

interface RunsListProps {
  /** Entries newest first (from scanRuns). */
  entries: readonly RunListEntry[];
  /** Called with the highlighted entry on Enter. */
  onSelect: (entry: RunListEntry) => void;
  /** Called on Esc. */
  onClose: () => void;
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
 * The /runs overlay: a scrollable, selectable list of past run
 * directories (R10). Arrow keys move, Enter selects, Esc closes; long
 * lists scroll within a fixed window.
 */
export function RunsList({
  entries,
  onSelect,
  onClose,
  limit = 8,
  now = Date.now,
}: RunsListProps) {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (entries.length === 0) return;
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
    } else if (key.downArrow) {
      setCursor((current) => Math.min(entries.length - 1, current + 1));
    } else if (key.return) {
      const entry = entries[cursor];
      if (entry !== undefined) onSelect(entry);
    }
  });

  const windowStart = Math.max(
    0,
    Math.min(cursor - Math.floor(limit / 2), entries.length - limit),
  );
  const visible = entries.slice(windowStart, windowStart + limit);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.primary} bold>
        Past runs
      </Text>
      {entries.length === 0 ? (
        <Text color={theme.muted}>  No runs yet — type a task to start one.</Text>
      ) : (
        visible.map((entry, index) => {
          const absolute = windowStart + index;
          const selected = absolute === cursor;
          const { glyph, color } = statusGlyph(entry.status);
          const started = Date.parse(entry.startedAt);
          const when = Number.isNaN(started)
            ? '?'
            : formatRelativeTime(started, now());
          return (
            <Box key={entry.id}>
              <Text color={selected ? theme.emphasis : undefined}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={color}>{`${glyph} `}</Text>
              <Text color={selected ? theme.emphasis : undefined}>
                {truncate(entry.task, TASK_SNIPPET_MAX)}
              </Text>
              <Text color={theme.muted}>{`  ${when}`}</Text>
            </Box>
          );
        })
      )}
      {entries.length > limit && (
        <Text color={theme.muted}>
          {`  ${cursor + 1}/${entries.length} · ↑↓ scroll`}
        </Text>
      )}
      <Text color={theme.muted}>  enter view · esc close</Text>
    </Box>
  );
}
