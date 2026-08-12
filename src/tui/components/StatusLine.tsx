import { Box, Text, useStdout } from 'ink';
import { useEffect, useState } from 'react';

import type { SherlockConfig } from '../config.js';
import { formatDuration, formatTokens } from '../format.js';
import type { RunChecklistSnapshot } from '../hooks/useRunChecklist.js';
import type { LiveRunState } from '../store/state.js';
import { glyphs, theme } from '../theme.js';
import { chooseCurrentTask, TaskChecklist } from './TaskChecklist.js';

/**
 * Pick a working word, never repeating the current one (R4's "no
 * immediate repeat"; a single-word list repeats by necessity).
 */
export function pickWord(
  words: readonly string[],
  current: string | undefined,
  rng: () => number,
): string {
  const pool =
    current === undefined ? words : words.filter((word) => word !== current);
  const source = pool.length > 0 ? pool : words;
  const index = Math.min(source.length - 1, Math.floor(rng() * source.length));
  return source[index] ?? '';
}

interface StatusLineProps {
  config: SherlockConfig;
  live: LiveRunState;
  /** App-owned disk snapshot; rendered by the checklist-aware status in Step 4. */
  checklist?: RunChecklistSnapshot;
  /** True while Esc has been pressed and the run is wrapping up. */
  cancelling?: boolean;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Injectable RNG in [0, 1) for tests. */
  rng?: () => number;
}

/**
 * The animated working state (R3/R4): spinner glyph + active checklist
 * form (or whimsical fallback), with metrics inline when they fit and on a
 * muted line when they do not. Ephemeral — never enters the transcript.
 */
export function StatusLine({
  config,
  live,
  checklist,
  cancelling = false,
  now = Date.now,
  rng = Math.random,
}: StatusLineProps) {
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(() =>
    pickWord(config.workingWords, undefined, rng),
  );
  const [, setClockTick] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setFrame((current) => current + 1),
      Math.max(16, Math.round(1000 / config.glyphFps)),
    );
    return () => clearInterval(id);
  }, [config.glyphFps]);

  useEffect(() => {
    const id = setInterval(
      () => setWord((current) => pickWord(config.workingWords, current, rng)),
      config.wordCycleMs,
    );
    return () => clearInterval(id);
  }, [config.wordCycleMs, config.workingWords, rng]);

  useEffect(() => {
    const id = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const glyph = glyphs.spinnerFrames[frame % glyphs.spinnerFrames.length];
  const tokens = formatTokens(Math.round(live.tokens.estimate));
  const elapsed = formatDuration(now() - live.startedAt);
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const activeTask = chooseCurrentTask(checklist?.tasks ?? []);
  const headline = cancelling ? 'Wrapping up' : activeTask?.activeForm ?? activeTask?.subject ?? word;
  const metricSummary = `(${elapsed} · ↓ ${tokens})`;
  const inlineMetrics =
    terminalWidth >= 60 && headline.length + metricSummary.length + 5 <= terminalWidth;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.primary}>{glyph}</Text>
        {` ${headline}…`}
        {inlineMetrics && (
          <Text color={theme.muted}>{`  ${metricSummary}`}</Text>
        )}
      </Text>
      {!inlineMetrics && (
        <Text color={theme.muted}>
          {`${glyphs.metadata} ${tokens} · ${elapsed} (esc to interrupt)`}
        </Text>
      )}
      {checklist?.visible && (
        <TaskChecklist
          tasks={checklist.tasks}
          variant="compact"
          width={terminalWidth}
        />
      )}
    </Box>
  );
}
