import { Box } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { ArtifactsPanel } from '../../src/tui/components/ArtifactsPanel.js';
import { Composer } from '../../src/tui/components/Composer.js';
import { Transcript } from '../../src/tui/components/Transcript.js';
import { createDemoScript } from '../../src/tui/demo.js';
import { createInitialState, deriveSuggestions, reduce } from '../../src/tui/store/reducer.js';
import { renderAt, tick } from './helpers.js';

// The full scripted run, folded through the real reducer — the exact
// pipeline --demo drives.
const finalState = createDemoScript(0).reduce(
  (state, step) => reduce(state, step.action),
  createInitialState(),
);

// An enabled composer stands in for App's idle state, where the passive
// completion panel renders (idle + a completed-run summary); a disabled
// one stands in for mid-run, where no panel belongs.
function fullShell(composerDisabled: boolean): ReactElement {
  return (
    <Box flexDirection="column">
      <Transcript items={finalState.transcript} />
      {!composerDisabled && finalState.completedRun !== undefined && (
        <ArtifactsPanel
          summary={finalState.completedRun}
          artifacts={finalState.artifacts}
          ui={finalState.artifactUi}
          focused={false}
          runDir={finalState.completedRun.runDir}
          dispatch={() => {}}
        />
      )}
      <Composer
        disabled={composerDisabled}
        composer={finalState.composer}
        suggestions={deriveSuggestions(finalState)}
        dispatch={() => {}}
        onSubmit={() => {}}
      />
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
    expect(frame).toContain('● Running a browser program');
    expect(frame).toContain('◆ Publishing an artifact → artifacts/investors.csv');
    expect(frame).toContain('✓ Brewed in 42s · 18.7k tokens');
    // …and the passive completion panel sits above the composer.
    expect(frame).toContain('tab to browse artifacts');
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
    expect(frame).toContain('◆ Publishing an artifact →');
    expect(frame).toContain('artifacts/investors.csv');
    expect(frame).toContain('tab to browse artifacts');
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
