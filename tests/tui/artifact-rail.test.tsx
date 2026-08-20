// The live artifact rail's contract: selectable rows in publish order
// (RunsList idiom), reducer-owned cursor/view (design decision 3 — the
// harness folds the rail's dispatches through the real reducer), the
// Enter detail card, and Space/o/r firing the injected open helpers with
// the artifact's absolute path from both views. Esc is App's key (see
// app.test.tsx for the detail-close-beats-cancel precedence).

import { render } from 'ink-testing-library';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ManifestEntry } from '../../src/run/artifacts.js';
import { ArtifactRail } from '../../src/tui/components/ArtifactRail.js';
import {
  createInitialState,
  reduce,
  type StoreAction,
  type UiAction,
} from '../../src/tui/store/reducer.js';
import type { SessionState } from '../../src/tui/store/state.js';
import {
  DOWN,
  expectNoOverflow,
  type ExternalAction,
  okAction,
  recorder,
  renderAt,
  tick,
  UP,
} from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const ENTER = '\r';

const ROWS_HINT = '↑↓ select · enter details · space preview · o open · r reveal';
const DETAIL_HINT = 'space preview · o open · r reveal · esc back';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const RUN_DIR = '/runs/2026-08-12_investigate';

function entryFor(index: number): ManifestEntry {
  return {
    filename: `artifacts/file-${index}.png`,
    sha256: SHA,
    sourceUrl: `https://x.test/page-${index}`,
    roles: ['evidence'],
    capturedAt: '2026-08-12T10:00:00.000Z',
  };
}

/** Fold a running session with `count` published artifacts. `null`
 * withholds the run_dir event (runDir-not-yet-known case). */
function runningState(count: number, runDir: string | null = RUN_DIR): SessionState {
  const actions: StoreAction[] = [
    { type: 'run_started', task: 'investigate', at: 0 },
    ...(runDir === null ? [] : [{ type: 'run_dir', runDir } satisfies StoreAction]),
    { type: 'turn_start', turn: 1 },
    ...Array.from(
      { length: count },
      (_, index): StoreAction => ({
        type: 'artifact_published',
        entry: entryFor(index),
        sizeBytes: 2_048,
        toolExecId: index + 1,
      }),
    ),
  ];
  return actions.reduce(reduce, createInitialState());
}

/** Mounts the rail over the real reducer, recording every dispatch. */
function Harness({
  initial,
  log,
  open = okAction,
  reveal = okAction,
  preview = okAction,
  limit = 8,
  active = true,
}: {
  initial: SessionState;
  log?: UiAction[];
  open?: ExternalAction;
  reveal?: ExternalAction;
  preview?: ExternalAction;
  limit?: number;
  active?: boolean;
}) {
  const [state, rawDispatch] = useReducer(reduce, initial);
  const dispatch = (action: UiAction) => {
    log?.push(action);
    rawDispatch(action);
  };
  return (
    <ArtifactRail
      artifacts={state.artifacts}
      ui={state.artifactUi}
      runDir={state.live?.runDir}
      dispatch={dispatch}
      open={open}
      reveal={reveal}
      preview={preview}
      limit={limit}
      active={active}
    />
  );
}

describe('ArtifactRail (rows view)', () => {
  it('renders nothing before the first publish (mounted run-long for its key hook)', async () => {
    const { lastFrame, unmount } = render(<Harness initial={runningState(0)} />);
    await tick();
    expect(lastFrame() ?? '').not.toContain('Artifacts');
    unmount();
  });

  it('renders publish-order rows with the cursor, sizes, and the hint line', async () => {
    const { lastFrame, unmount } = render(<Harness initial={runningState(2)} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Artifacts');
    expect(frame).toContain('› ◆ artifacts/file-0.png');
    expect(frame).toContain('  ◆ artifacts/file-1.png');
    expect(frame).toContain('2.0 KB');
    expect(frame).toContain(ROWS_HINT);
    unmount();
  });

  it('↑↓ move the cursor, clamped at both ends', async () => {
    const { lastFrame, stdin, unmount } = render(<Harness initial={runningState(2)} />);
    await tick();
    stdin.write(UP); // clamped at the top
    await tick();
    expect(lastFrame()).toContain('› ◆ artifacts/file-0.png');
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('› ◆ artifacts/file-1.png');
    stdin.write(DOWN); // clamped at the bottom
    await tick();
    expect(lastFrame()).toContain('› ◆ artifacts/file-1.png');
    unmount();
  });

  it('windows long lists and scrolls with the cursor', async () => {
    const { lastFrame, stdin, unmount } = render(<Harness initial={runningState(12)} limit={4} />);
    await tick();
    expect(lastFrame()).toContain('artifacts/file-0.png');
    expect(lastFrame()).not.toContain('artifacts/file-11.png');
    for (let presses = 0; presses < 11; presses++) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain('› ◆ artifacts/file-11.png');
    expect(lastFrame()).not.toContain('artifacts/file-0.png');
    expect(lastFrame()).toContain('12/12');
    unmount();
  });

  it('renders with zero overflow at 44 columns', async () => {
    const { lastFrame, unmount } = renderAt(44, <Harness initial={runningState(3)} />);
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('◆ artifacts/file-0.png');
    expectNoOverflow(frame, 44);
    unmount();
  });
});

describe('ArtifactRail (detail view)', () => {
  it("Enter opens the highlighted artifact's full provenance card", async () => {
    const { lastFrame, stdin, unmount } = render(<Harness initial={runningState(2)} />);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Artifacts · 2/2');
    expect(frame).toContain('◆ artifacts/file-1.png');
    expect(frame).toContain('source: https://x.test/page-1');
    expect(frame).toContain(`sha256: ${SHA}`);
    expect(frame).toContain('2.0 KB on disk');
    expect(frame).toContain(DETAIL_HINT);
    // The rows (and their hint) are replaced by the card.
    expect(frame).not.toContain(ROWS_HINT);
    expect(frame).not.toContain('artifacts/file-0.png');
    unmount();
  });
});

describe('ArtifactRail (space/o/r external opens)', () => {
  it('Space/o/r call the injected helpers with the absolute artifact path', async () => {
    const preview = recorder();
    const open = recorder();
    const reveal = recorder();
    const { stdin, unmount } = render(
      <Harness
        initial={runningState(2)}
        preview={preview.action}
        open={open.action}
        reveal={reveal.action}
      />,
    );
    await tick();
    stdin.write(DOWN); // act on the second row
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('o');
    await tick();
    stdin.write('r');
    await tick();
    const expected = `${RUN_DIR}/artifacts/file-1.png`;
    expect(preview.paths).toEqual([expected]);
    expect(open.paths).toEqual([expected]);
    expect(reveal.paths).toEqual([expected]);
    unmount();
  });

  it('Space/o/r work from the detail view too', async () => {
    const preview = recorder();
    const open = recorder();
    const reveal = recorder();
    const { lastFrame, stdin, unmount } = render(
      <Harness
        initial={runningState(2)}
        preview={preview.action}
        open={open.action}
        reveal={reveal.action}
      />,
    );
    await tick();
    stdin.write(ENTER); // open the first artifact's card
    await tick();
    expect(lastFrame()).toContain(DETAIL_HINT);
    stdin.write(' ');
    await tick();
    stdin.write('o');
    await tick();
    stdin.write('r');
    await tick();
    const expected = `${RUN_DIR}/artifacts/file-0.png`;
    expect(preview.paths).toEqual([expected]);
    expect(open.paths).toEqual([expected]);
    expect(reveal.paths).toEqual([expected]);
    // The card stayed open throughout.
    expect(lastFrame()).toContain(DETAIL_HINT);
    unmount();
  });

  it('a failed helper result dispatches a notice, never a crash', async () => {
    const preview = recorder({
      ok: false,
      message: 'qlmanage failed to launch: spawn qlmanage ENOENT',
    });
    const log: UiAction[] = [];
    const { stdin, unmount } = render(
      <Harness initial={runningState(1)} log={log} preview={preview.action} />,
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

  it('with the run dir not yet known, keys notice instead of spawning', async () => {
    const preview = recorder();
    const log: UiAction[] = [];
    const { stdin, unmount } = render(
      <Harness initial={runningState(1, null)} log={log} preview={preview.action} />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    expect(preview.paths).toEqual([]);
    expect(log).toContainEqual({
      type: 'notice',
      text: 'The run directory is not known yet — try again in a moment.',
    });
    unmount();
  });
});

describe('ArtifactRail while a question dialog owns the keys', () => {
  it('active={false} leaves rows visible but every key inert', async () => {
    // Ink broadcasts each keypress to every mounted useInput, so while a
    // question dialog is open App flips the rail inactive — otherwise ↑↓
    // would drive the dialog's selection and the rail's cursor at once.
    const log: UiAction[] = [];
    const preview = recorder();
    const { stdin, lastFrame, unmount } = render(
      <Harness initial={runningState(2)} log={log} preview={preview.action} active={false} />,
    );
    await tick();
    expect(lastFrame()).toContain('artifacts/file-0.png');

    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(' ');
    await tick();
    expect(log).toEqual([]);
    expect(preview.paths).toEqual([]);
    expect(lastFrame()).toContain(ROWS_HINT);
    unmount();
  });
});
