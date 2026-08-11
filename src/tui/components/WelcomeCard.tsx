import { Box, Text, useStdout } from 'ink';

import { middleTruncate, truncate } from '../format.js';
import type { BannerIdentity } from '../store/state.js';
import { glyphs, theme } from '../theme.js';

/** Title embedded in the card's top border chrome. */
const TITLE = 'Sherlock — evidence collection agent';

/** The card never grows past this, however wide the terminal is. */
const MAX_WIDTH = 64;

/** Columns eaten around content: two border cells + paddingX of 1. */
const CHROME = 4;

/**
 * The deterministic magnifying-glass art: an octagonal lens with the
 * evidence ◆ at its focus and a diagonal handle. Every character is a
 * one-column box-drawing/geometric glyph, so each row's string length is
 * its display width.
 */
const ART = {
  top: ' ╭───╮',
  upper: '╭╯   ╰╮',
  midLeft: '│  ',
  gem: glyphs.evidence,
  midRight: '  │',
  lower: '╰╮   ╭╯',
  bottom: ' ╰───╯╲',
  handle: '       ╲',
  /** Widest row — the column box the art left-aligns inside. */
  width: 8,
} as const;

/**
 * The custom top border: Ink has no native border title, so the top line
 * renders as a Text whose display width exactly matches the bordered Box
 * below it (`╭─ Sherlock — evidence collection agent ─…──╮`). The title
 * truncates on narrow terminals; very narrow cards drop it entirely.
 */
function topBorderLine(cardWidth: number): string {
  const inner = Math.max(2, cardWidth - 2);
  if (inner < 8) return `╭${'─'.repeat(inner)}╮`;
  const label = truncate(TITLE, inner - 4);
  const body = `─ ${label} `;
  return `╭${body}${'─'.repeat(inner - body.length)}╮`;
}

/** `{model} · {cwd}`, the path middle-truncated to fit the card. */
function footerLine(identity: BannerIdentity, contentWidth: number): string {
  const lead = `${identity.model} · `;
  const path = middleTruncate(identity.cwd, Math.max(1, contentWidth - lead.length));
  return truncate(`${lead}${path}`, contentWidth);
}

/**
 * The startup welcome card (the banner transcript item): round border in
 * the primary color with the title in the top border chrome, a bold
 * centered welcome line, the magnifying-glass art, and a muted
 * `model · cwd` footer. Without an injected identity it falls back to a
 * generic card (no name, no footer). Lives in <Static>, so the terminal
 * width is read once at first render — acceptable for a startup card.
 */
export function WelcomeCard({
  apiKeyPresent,
  identity,
}: {
  apiKeyPresent: boolean;
  identity?: BannerIdentity | undefined;
}) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const cardWidth = Math.min(columns - 2, MAX_WIDTH);
  const contentWidth = cardWidth - CHROME;
  const welcome =
    identity === undefined ? 'Welcome back!' : `Welcome back ${identity.name}!`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.primary}>{topBorderLine(cardWidth)}</Text>
      <Box
        width={cardWidth}
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={theme.primary}
        paddingX={1}
      >
        <Box justifyContent="center">
          <Text bold>{truncate(welcome, contentWidth)}</Text>
        </Box>
        <Box justifyContent="center" marginTop={1}>
          <Box flexDirection="column" width={ART.width}>
            <Text color={theme.activity}>{ART.top}</Text>
            <Text color={theme.activity}>{ART.upper}</Text>
            <Text>
              <Text color={theme.activity}>{ART.midLeft}</Text>
              <Text color={theme.emphasis} bold>
                {ART.gem}
              </Text>
              <Text color={theme.activity}>{ART.midRight}</Text>
            </Text>
            <Text color={theme.activity}>{ART.lower}</Text>
            <Text color={theme.activity}>{ART.bottom}</Text>
            <Text color={theme.activity}>{ART.handle}</Text>
          </Box>
        </Box>
        {identity !== undefined && (
          <Box justifyContent="center" marginTop={1}>
            <Text color={theme.muted}>{footerLine(identity, contentWidth)}</Text>
          </Box>
        )}
      </Box>
      {!apiKeyPresent && (
        <Text color={theme.error}>
          {`${glyphs.retried} ANTHROPIC_API_KEY is not set — investigations will fail until it is configured.`}
        </Text>
      )}
    </Box>
  );
}
