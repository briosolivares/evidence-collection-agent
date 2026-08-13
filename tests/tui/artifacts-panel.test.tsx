// The completion summary panel's contract (plan item 6): a passive
// summary above the composer — ✓ header matching the completion line,
// clamped answer, artifact rows with requested outputs first, the tab
// hint — and, once focused (mode 'artifacts'), the same selection /
// detail / Space-o-r interaction as the live rail. Tab and Esc belong to
// App (see app.test.tsx for the focus round-trip).

import { render } from 'ink-testing-library';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ManifestEntry } from '../../src/run/artifacts.js';
import { ArtifactsPanel } from '../../src/tui/components/ArtifactsPanel.js';
import type { OpenExternalResult } from '../../src/tui/openExternal.js';
import {
  createInitialState,
  reduce,
  type StoreAction,
  type UiAction,
} from '../../src/tui/store/reducer.js';
import type { SessionState } from '../../src/tui/store/state.js';
import { renderAt, tick } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const DOWN = '\u001b[B';
const ENTER = '\r';

const PASSIVE_HINT = 'tab to browse artifacts';
const FOCUSED_HINT =
  '↑↓ select · enter details · space preview · o open · r reveal · esc done';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const RUN_DIR = '/runs/2026-08-12_investigate';

/** Two evidence captures then a requested output, in publish order. */
function publishes(): StoreAction[] {
  const entries: ManifestEntry[] = [
    {
      filename: 'artifacts/page.png',
      sha256: SHA,
      sourceUrl: 'https://x.test/page',
      roles: ['evidence'],
      capturedAt: '2026-08-12T10:00:00.000Z',
    },
    {
      filename: 'artifacts/filing.png',
      sha256: SHA,
      sourceUrl: 'https://x.test/filing',
      roles: ['evidence'],
      capturedAt: '2026-08-12T10:01:00.000Z',
    },
    {
      filename: 'artifacts/top5.csv',
      sha256: SHA,
      roles: ['requested_output'],
      capturedAt: '2026-08-12T10:02:00.000Z',
    },
  ];
  return entries.map((entry, index) => ({
    type: 'artifact_published',
    entry,
    sizeBytes: 2_048,
    toolExecId: index + 1,
  }));
}

/** Fold a whole completed run; optionally focus the panel afterwards. */
function completedState(options: {
  finalText?: string;
  focused?: boolean;
  publishCount?: number;
} = {}): SessionState {
  const actions: StoreAction[] = [
    { type: 'run_started', task: 'investigate', at: 0 },
    { type: 'run_dir', runDir: RUN_DIR },
    { type: 'turn_start', turn: 1 },
    ...publishes().slice(0, options.publishCount ?? 3),
    { type: 'turn_end', usage: { input: 17_000, output: 1_700 } },
    {
      type: 'run_finished',
      outcome: 'completed',
      ...(options.finalText === undefined ? {} : { finalText: options.finalText }),
      runDir: RUN_DIR,
      at: 42_000,
    },
    ...(options.focused === true
      ? [{ type: 'artifacts_focus' } satisfies StoreAction]
      : []),
  ];
  return actions.reduce(reduce, createInitialState());
}

type ExternalAction = (absPath: string) => Promise<OpenExternalResult>;

/** An injected helper that records its paths and resolves a result. */
function recorder(result: OpenExternalResult = { ok: true }) {
  const paths: string[] = [];
  const action: ExternalAction = (absPath) => {
    paths.push(absPath);
    return Promise.resolve(result);
  };
  return { paths, action };
}

const okAction: ExternalAction = () => Promise.resolve({ ok: true });

/** Mounts the panel over the real reducer, as App does. */
function Harness({
  initial,
  log,
  open = okAction,
  reveal = okAction,
  preview = okAction,
}: {
  initial: SessionState;
  log?: UiAction[];
  open?: ExternalAction;
  reveal?: ExternalAction;
  preview?: ExternalAction;
}) {
  const [state, rawDispatch] = useReducer(reduce, initial);
  const dispatch = (action: UiAction) => {
    log?.push(action);
    rawDispatch(action);
  };
  if (state.completedRun === undefined) return null;
  return (
    <ArtifactsPanel
      summary={state.completedRun}
      artifacts={state.artifacts}
      ui={state.artifactUi}
      focused={state.mode === 'artifacts'}
      runDir={state.completedRun.runDir}
      dispatch={dispatch}
      open={open}
      reveal={reveal}
      preview={preview}
    />
  );
}

describe('ArtifactsPanel (passive)', () => {
  it('renders the ✓ header, run dir, answer, and the tab hint', async () => {
    const { lastFrame, unmount } = render(
      <Harness initial={completedState({ finalText: 'Top five saved to top5.csv.' })} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓ Brewed in 42s · 18.7k tokens');
    expect(frame).toContain(RUN_DIR);
    expect(frame).toContain('Top five saved to top5.csv.');
    expect(frame).toContain(PASSIVE_HINT);
    expect(frame).not.toContain(FOCUSED_HINT);
    unmount();
  });

  it('lists requested outputs before evidence, publish order within groups', async () => {
    const { lastFrame, unmount } = render(<Harness initial={completedState()} />);
    await tick();
    const frame = lastFrame() ?? '';
    const positions = [
      'artifacts/top5.csv',
      'artifacts/page.png',
      'artifacts/filing.png',
    ].map((name) => frame.indexOf(name));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    unmount();
  });

  it('shows no selection cursor and ignores keys while passive', async () => {
    const preview = recorder();
    const { lastFrame, stdin, unmount } = render(
      <Harness initial={completedState()} preview={preview.action} />,
    );
    await tick();
    expect(lastFrame()).not.toContain('› ');
    stdin.write(DOWN);
    await tick();
    stdin.write(' ');
    await tick();
    expect(preview.paths).toEqual([]);
    expect(lastFrame()).not.toContain('› ');
    unmount();
  });

  it('falls back to "Task completed" when finalText is empty or absent', async () => {
    const absent = render(<Harness initial={completedState()} />);
    await tick();
    expect(absent.lastFrame()).toContain('Task completed');
    absent.unmount();
    const empty = render(<Harness initial={completedState({ finalText: '  \n ' })} />);
    await tick();
    expect(empty.lastFrame()).toContain('Task completed');
    empty.unmount();
  });

  it('clamps a long answer to a few lines with a trailing ellipsis', async () => {
    const finalText = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const { lastFrame, unmount } = render(
      <Harness initial={completedState({ finalText })} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('one');
    expect(frame).toContain('three');
    expect(frame).not.toContain('four');
    expect(frame).toContain('…');
    unmount();
  });

  it('omits the rows and hint when the run published nothing', async () => {
    const { lastFrame, unmount } = render(
      <Harness initial={completedState({ publishCount: 0, finalText: 'Done.' })} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓ Brewed in 42s');
    expect(frame).not.toContain(PASSIVE_HINT);
    expect(frame).not.toContain('◆');
    unmount();
  });

  it('renders with zero overflow at 44 columns', async () => {
    const { lastFrame, unmount } = renderAt(
      44,
      <Harness initial={completedState({ finalText: 'Saved.' })} />,
    );
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('◆ artifacts/top5.csv');
    for (const line of frame.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(44);
    }
    unmount();
  });
});

describe('ArtifactsPanel (focused)', () => {
  it('shows the cursor on the first (requested-output) row and navigates', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Harness initial={completedState({ focused: true })} />,
    );
    await tick();
    expect(lastFrame()).toContain('› ◆ artifacts/top5.csv');
    expect(lastFrame()).toContain(FOCUSED_HINT);
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('› ◆ artifacts/page.png');
    unmount();
  });

  it("Enter opens the highlighted artifact's provenance card", async () => {
    const { lastFrame, stdin, unmount } = render(
      <Harness initial={completedState({ focused: true })} />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Artifacts · 1/3');
    expect(frame).toContain(`sha256: ${SHA}`);
    // The completion header stays above the card.
    expect(frame).toContain('✓ Brewed in 42s');
    expect(frame).not.toContain(FOCUSED_HINT);
    unmount();
  });

  it('Space/o/r act on the highlighted artifact against the run dir', async () => {
    const preview = recorder();
    const open = recorder();
    const reveal = recorder();
    const { stdin, unmount } = render(
      <Harness
        initial={completedState({ focused: true })}
        preview={preview.action}
        open={open.action}
        reveal={reveal.action}
      />,
    );
    await tick();
    stdin.write(DOWN); // requested output first, so this is page.png
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('o');
    await tick();
    stdin.write('r');
    await tick();
    const expected = `${RUN_DIR}/artifacts/page.png`;
    expect(preview.paths).toEqual([expected]);
    expect(open.paths).toEqual([expected]);
    expect(reveal.paths).toEqual([expected]);
    unmount();
  });

  it('a failed helper result dispatches a notice, never a crash', async () => {
    const preview = recorder({
      ok: false,
      message: 'qlmanage failed to launch: spawn qlmanage ENOENT',
    });
    const log: UiAction[] = [];
    const { stdin, unmount } = render(
      <Harness
        initial={completedState({ focused: true })}
        log={log}
        preview={preview.action}
      />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    expect(preview.paths).toHaveLength(1);
    expect(log).toContainEqual({
      type: 'notice',
      text: 'qlmanage failed to launch: spawn qlmanage ENOENT',
    });
    unmount();
  });
});
