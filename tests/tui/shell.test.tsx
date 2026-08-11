import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { ENTER, tick, typeText } from './helpers.js';

const config = createConfig();

describe('sherlock shell (step 1 scaffold)', () => {
  it('renders the banner and the composer', async () => {
    const { lastFrame, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sherlock');
    expect(frame).toContain('›');
    expect(frame).toContain('/help for commands');
    unmount();
  });

  it('shows a styled notice when text is submitted', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await typeText(stdin, 'find the filings');
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('find the filings');
    expect(frame).toContain("isn't wired up yet");
    unmount();
  });

  it('warns in the banner when the API key is missing', async () => {
    const { lastFrame, unmount } = render(
      <App config={config} apiKeyPresent={false} />,
    );
    await tick();
    expect(lastFrame()).toContain('ANTHROPIC_API_KEY is not set');
    unmount();
  });
});
