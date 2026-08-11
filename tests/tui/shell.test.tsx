import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import type { BannerIdentity } from '../../src/tui/store/state.js';
import { ENTER, renderAt, tick, typeText } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const config = createConfig();

/** Fixed identity injected where a test asserts the welcome card. */
const identity: BannerIdentity = {
  name: 'Brios',
  model: 'claude-sonnet-5',
  cwd: '~/Desktop/Code/evidence-collection-agent',
};

/** Widest display line in a frame (all glyphs here are one column). */
function maxLineWidth(frame: string): number {
  return Math.max(...frame.split('\n').map((line) => [...line].length));
}

describe('sherlock shell', () => {
  it('renders the banner and the composer', async () => {
    const { frames, lastFrame, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›');
    expect(frame).toContain('/help for commands');
    expect(frames.join('\n')).toContain('Sherlock');
    unmount();
  });

  it('renders the welcome card with the injected identity', async () => {
    const { frames, unmount } = render(
      <App config={config} apiKeyPresent={true} identity={identity} />,
    );
    await tick();
    const output = frames.join('\n');
    // Title embedded in the top border chrome.
    expect(output).toContain('╭─ Sherlock — evidence collection agent ─');
    // Bold centered welcome line with the injected first name.
    expect(output).toContain('Welcome back Brios!');
    // The magnifying-glass glyph art (lens rows + gem + handle).
    expect(output).toContain('╭╯   ╰╮');
    expect(output).toContain('│  ◆  │');
    expect(output).toContain('╰───╯╲');
    // Muted `model · cwd` footer.
    expect(output).toContain('claude-sonnet-5 · ~/Desktop/Code/evidence-collection-agent');
    unmount();
  });

  it('renders the generic card when no identity is injected', async () => {
    const { frames, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('╭─ Sherlock — evidence collection agent ─');
    expect(output).toContain('Welcome back!');
    expect(output).toContain('│  ◆  │');
    // No identity → no model · cwd footer.
    expect(output).not.toContain(' · ');
    unmount();
  });

  it('keeps the welcome card within 44 columns, warning included', async () => {
    const { lastFrame, unmount } = renderAt(
      44,
      <App config={config} apiKeyPresent={false} identity={identity} />,
    );
    await tick();
    const frame = lastFrame();
    // Card width is min(44 − 2, 64) = 42; the full title still fits.
    expect(frame).toContain('╭─ Sherlock — evidence collection agent ─╮');
    expect(frame).toContain('Welcome back Brios!');
    // The path middle-truncates to fit next to the model id.
    expect(frame).toMatch(/claude-sonnet-5 · ~\/Desk.*…/);
    expect(frame).toContain('ANTHROPIC_API_KEY is not set');
    // Zero overflow: no rendered line wider than the terminal.
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(44);
    unmount();
  });

  it('truncates the border title on very narrow terminals', async () => {
    const { lastFrame, unmount } = renderAt(
      36,
      <App config={config} apiKeyPresent={true} identity={identity} />,
    );
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('╭─ Sherlock — evidence collect… ─╮');
    expect(maxLineWidth(frame)).toBeLessThanOrEqual(36);
    unmount();
  });

  it('renders submitted text into the transcript', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await typeText(stdin, 'find the filings');
    stdin.write(ENTER);
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('▸ find the filings');
    unmount();
  });

  it('warns in the banner when the API key is missing', async () => {
    const { frames, unmount } = render(
      <App config={config} apiKeyPresent={false} />,
    );
    await tick();
    expect(frames.join('\n')).toContain('ANTHROPIC_API_KEY is not set');
    unmount();
  });
});
