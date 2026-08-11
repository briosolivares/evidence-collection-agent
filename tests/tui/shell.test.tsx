import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { ENTER, tick, typeText } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const config = createConfig();

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
