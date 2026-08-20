import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { formatDuration, formatTokens } from '../format.js';
import type { LiveRunState } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

const DEFAULT_WORKING_WORDS: readonly string[] = [
  'Foraging',
  'Sifting',
  'Rummaging',
  'Ferreting',
  'Digging',
  'Scouring',
  'Tracing',
  'Poking around',
  'Connecting dots',
  'Following leads',
  'Chasing citations',
  'Dusting for clues',
  'Reading the fine print',
  'Peeking under rocks',
  'Untangling threads',
  'Consulting the archives',
  'Cross-examining the web',
  'Separating signal from noise',
  'Brewing',
];
const GLYPH_FPS = 4;

/**
 * Pick a working word, never repeating the current one (R4's "no
 * immediate repeat"; a single-word list repeats by necessity).
 */
export function pickWord(
  words: readonly string[],
  current: string | undefined,
  rng: () => number,
): string {
  const pool = current === undefined ? words : words.filter((word) => word !== current);
  const source = pool.length > 0 ? pool : words;
  const index = Math.min(source.length - 1, Math.floor(rng() * source.length));
  return source[index] ?? '';
}

interface StatusLineProps {
  live: LiveRunState;
  workingWords?: readonly string[];
  wordCycleMs?: number;
  /** True while Esc has been pressed and the run is wrapping up. */
  cancelling?: boolean;
  /** True after a soft interrupt while Sherlock waits for a user update. */
  interrupted?: boolean;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Injectable RNG in [0, 1) for tests. */
  rng?: () => number;
}

/**
 * The animated working state (R3/R4): spinner glyph + whimsical word,
 * with `↳ tokens · elapsed` metadata beneath. Ephemeral — never enters
 * the transcript.
 */
export function StatusLine({
  live,
  workingWords = DEFAULT_WORKING_WORDS,
  wordCycleMs = 6_000,
  cancelling = false,
  interrupted = false,
  now = Date.now,
  rng = Math.random,
}: StatusLineProps) {
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(() => pickWord(workingWords, undefined, rng));
  const [, setClockTick] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setFrame((current) => current + 1),
      Math.max(16, Math.round(1000 / GLYPH_FPS)),
    );
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(
      () => setWord((current) => pickWord(workingWords, current, rng)),
      wordCycleMs,
    );
    return () => clearInterval(id);
  }, [wordCycleMs, workingWords, rng]);

  useEffect(() => {
    const id = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const glyph = glyphs.spinnerFrames[frame % glyphs.spinnerFrames.length];
  const label = cancelling ? 'Wrapping up' : interrupted ? 'Paused for your update' : word;
  const tokens = formatTokens(Math.round(live.tokens.estimate));
  const elapsed = formatDuration(now() - live.startedAt);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.primary}>{glyph}</Text>
        {` ${label}…`}
      </Text>
      <Text color={theme.muted}>
        {`${glyphs.metadata} ${tokens} · ${elapsed} ${
          interrupted ? '(enter to resume · esc again to cancel)' : '(esc to interrupt)'
        }`}
      </Text>
    </Box>
  );
}
