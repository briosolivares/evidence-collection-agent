import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { Box } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Composer } from '../../src/tui/components/Composer.js';
import { Transcript } from '../../src/tui/components/Transcript.js';
import { createDemoScript } from '../../src/tui/demo.js';
import { createInitialState, reduce } from '../../src/tui/store/reducer.js';
import { tick } from './helpers.js';

// A width-controllable render harness (ink-testing-library fixes the
// terminal at 100 columns; the rendering contract must hold on narrow
// terminals too). Ink's debug mode writes complete frames.
function renderAt(width: number, tree: ReactElement) {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: width,
    rows: 40,
    isTTY: true,
    write: (data: string) => {
      frames.push(data);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => null,
    unref: () => {},
    ref: () => {},
    resume: () => {},
    pause: () => {},
  });
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: () => frames.at(-1) ?? '',
    unmount: () => instance.unmount(),
  };
}

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
