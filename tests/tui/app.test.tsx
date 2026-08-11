import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { ENTER, tick, typeText } from './helpers.js';

const config = createConfig();

async function submitLine(
  stdin: { write: (data: string) => void },
  line: string,
): Promise<void> {
  await typeText(stdin, line);
  stdin.write(ENTER);
  await tick();
}

describe('App slash routing and transcript', () => {
  it('appends submitted tasks and keeps earlier entries visible', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, 'first investigation');
    await submitLine(stdin, 'second investigation');
    const output = frames.join('\n');
    expect(output).toContain('▸ first investigation');
    expect(output).toContain('▸ second investigation');
    unmount();
  });

  it('/help renders the command list and keys', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/help');
    const output = frames.join('\n');
    expect(output).toContain('/runs');
    expect(output).toContain('/evals');
    expect(output).toContain('/exit');
    expect(output).toContain('Esc');
    unmount();
  });

  it('unknown commands get a gentle notice', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/frobnicate');
    const output = frames.join('\n');
    expect(output).toContain("/frobnicate isn't a command I know");
    expect(output).toContain('/help');
    unmount();
  });

  it('/exit exits through the app lifecycle', async () => {
    const onExit = vi.fn();
    const { stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} onExit={onExit} />,
    );
    await tick();
    await submitLine(stdin, '/exit');
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });
});
