import { Box } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Composer } from '../../src/tui/components/Composer.js';
import { Transcript } from '../../src/tui/components/Transcript.js';
import { createDemoScript } from '../../src/tui/demo.js';
import { createInitialState, reduce } from '../../src/tui/store/reducer.js';
import { renderAt, tick } from './helpers.js';

// The full scripted run, folded through the real reducer — the exact
// pipeline --demo drives.
const finalState = createDemoScript(0).reduce(
  (state, step) => reduce(state, step.action),
  createInitialState(),
);

function fullShell(composerDisabled: boolean): ReactElement {
  return (
    <Box flexDirection="column">
      <Transcript items={finalState.transcript} />
      <Composer disabled={composerDisabled} onSubmit={() => {}} />
    </Box>
  );
}

describe('smoke: full scripted-run rendering contract', () => {
  it('locks the frame at normal width (80 columns)', async () => {
    const { lastFrame, unmount } = renderAt(80, fullShell(false));
    await tick();
    const frame = lastFrame();
    // The transcript story is all present…
    expect(frame).toContain("▸ Find Acme Corp's Series B investors");
    expect(frame).toContain("I'll start with recent funding coverage");
    expect(frame).toContain('● Opening techcrunch.com/2026/05/14/acme-series-b');
    expect(frame).toContain('◆ Evidence saved → investors.csv');
    expect(frame).toContain('✓ Brewed in 42s · 18.7k tokens');
    expect(frame).toContain('›');
    // …and the exact rendering is locked.
    expect(frame).toMatchSnapshot();
    unmount();
  });

  it('locks the frame at narrow width (44 columns)', async () => {
    const { lastFrame, unmount } = renderAt(44, fullShell(false));
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('✓ Brewed in 42s · 18.7k tokens');
    expect(frame).toContain('◆ Evidence saved → investors.csv');
    expect(frame).toMatchSnapshot();
    unmount();
  });

  it('locks the waiting composer state', async () => {
    const { lastFrame, unmount } = renderAt(80, fullShell(true));
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('(waiting for agent…)');
    expect(frame).toMatchSnapshot();
    unmount();
  });
});
