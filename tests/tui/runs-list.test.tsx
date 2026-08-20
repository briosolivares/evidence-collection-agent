import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { RunsList, type RunSummaryView } from '../../src/tui/components/RunsList.js';
import type { RunListEntry } from '../../src/tui/runScanner.js';
import { DOWN, ESC, expectNoOverflow, LEFT, renderAt, RIGHT, tick, UP } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const ENTER = '\r';

const LIST_HINTS = '↑↓ select · enter view · esc close';
const DETAIL_HINTS = '↑↓ prev/next run · ← back · esc back';

function entry(index: number, status: RunListEntry['status'] = 'complete'): RunListEntry {
  return {
    runDir: `/runs/run-${index}`,
    id: `run-${index}`,
    task: `task number ${index}`,
    startedAt: new Date(1_754_900_000_000 - index * 3_600_000).toISOString(),
    status,
  };
}

/** A deterministic summary fixture keyed on the runDir's index. */
function summaryFor(runDir: string): RunSummaryView {
  const index = Number(runDir.split('run-')[1]);
  return {
    manifest: {
      task: `task number ${index}`,
      startedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: '2026-08-11T10:01:24.000Z',
      artifacts: [
        {
          filename: `evidence-${index}.csv`,
          sizeBytes: 2_048,
          sha256Prefix: `deadbeefcaf${index}`,
          sourceUrl: 'https://news.ycombinator.com/',
        },
      ],
    },
    metrics: {
      status: 'completed',
      turns: 5,
      totalTokens: 31_200,
      wallClockMs: 84_000,
    },
  };
}

const now = () => 1_754_900_000_000;

describe('RunsList (list level)', () => {
  it('renders rows with status glyphs, relative dates, and hints', async () => {
    const entries = [entry(0, 'complete'), entry(1, 'unfinished'), entry(2, 'stopped')];
    const { lastFrame, unmount } = render(
      <RunsList entries={entries} onClose={() => {}} loadSummary={summaryFor} now={now} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓ task number 0');
    expect(frame).toContain('◐ task number 1');
    expect(frame).toContain('✗ task number 2');
    expect(frame).toContain('1h ago');
    expect(frame).toContain(LIST_HINTS);
    expect(frame).not.toContain('crash');
    unmount();
  });

  it('windows long lists and scrolls with the cursor', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => entry(index));
    const { lastFrame, stdin, unmount } = render(
      <RunsList
        entries={entries}
        onClose={() => {}}
        loadSummary={summaryFor}
        limit={4}
        now={now}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('task number 0');
    expect(lastFrame()).not.toContain('task number 11');
    for (let presses = 0; presses < 11; presses++) {
      stdin.write(DOWN);
      await tick();
    }
    expect(lastFrame()).toContain('task number 11');
    expect(lastFrame()).not.toContain('task number 0 ');
    expect(lastFrame()).toContain('12/12');
    stdin.write(UP);
    await tick();
    expect(lastFrame()).toContain('11/12');
    unmount();
  });

  it('Esc closes the overlay from the list', async () => {
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <RunsList entries={[entry(0)]} onClose={onClose} loadSummary={summaryFor} now={now} />,
    );
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shows a friendly empty state', async () => {
    const { lastFrame, unmount } = render(
      <RunsList entries={[]} onClose={() => {}} loadSummary={summaryFor} now={now} />,
    );
    await tick();
    expect(lastFrame()).toContain('No runs yet');
    unmount();
  });
});

describe('RunsList (detail level)', () => {
  it("Enter opens the highlighted run's summary inside the overlay", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <RunsList
        entries={[entry(0), entry(1)]}
        onClose={onClose}
        loadSummary={summaryFor}
        now={now}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('task number 1');
    expect(frame).toContain('completed · 5 turns · 31.2k tokens · 1m 24s');
    expect(frame).toContain('evidence-1.csv');
    expect(frame).toContain('2.0 KB');
    expect(frame).toContain('sha256 deadbeefcaf1');
    expect(frame).toContain('/runs/run-1');
    expect(frame).toContain('run 2/2');
    expect(frame).toContain(DETAIL_HINTS);
    // The list rows are gone and the overlay stayed open.
    expect(frame).not.toContain('task number 0');
    expect(onClose).not.toHaveBeenCalled();
    unmount();
  });

  it('→ opens the detail too', async () => {
    const { lastFrame, stdin, unmount } = render(
      <RunsList entries={[entry(0)]} onClose={() => {}} loadSummary={summaryFor} now={now} />,
    );
    await tick();
    stdin.write(RIGHT);
    await tick();
    expect(lastFrame()).toContain('evidence-0.csv');
    expect(lastFrame()).toContain(DETAIL_HINTS);
    unmount();
  });

  it('← returns to the list with the cursor preserved', async () => {
    const { lastFrame, stdin, unmount } = render(
      <RunsList
        entries={[entry(0), entry(1), entry(2)]}
        onClose={() => {}}
        loadSummary={summaryFor}
        now={now}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain(DETAIL_HINTS);
    stdin.write(LEFT);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(LIST_HINTS);
    expect(frame).toContain('› ✓ task number 1');
    unmount();
  });

  it('Esc in detail returns to the list instead of closing', async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <RunsList
        entries={[entry(0), entry(1)]}
        onClose={onClose}
        loadSummary={summaryFor}
        now={now}
      />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onClose).not.toHaveBeenCalled();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(LIST_HINTS);
    expect(frame).toContain('› ✓ task number 1');
    unmount();
  });

  it("↑/↓ in detail jump to the previous/next run's detail, clamped at the ends", async () => {
    const { lastFrame, stdin, unmount } = render(
      <RunsList
        entries={[entry(0), entry(1), entry(2)]}
        onClose={() => {}}
        loadSummary={summaryFor}
        now={now}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('evidence-0.csv');
    stdin.write(UP); // clamped at the top
    await tick();
    expect(lastFrame()).toContain('evidence-0.csv');
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('evidence-1.csv');
    stdin.write(DOWN);
    await tick();
    expect(lastFrame()).toContain('evidence-2.csv');
    expect(lastFrame()).toContain('run 3/3');
    stdin.write(DOWN); // clamped at the bottom
    await tick();
    expect(lastFrame()).toContain('evidence-2.csv');
    // Back to the list: the cursor followed the detail navigation.
    stdin.write(LEFT);
    await tick();
    expect(lastFrame()).toContain('› ✓ task number 2');
    unmount();
  });

  it('renders the detail with zero overflow at 44 columns', async () => {
    const { lastFrame, stdin, unmount } = renderAt(
      44,
      <RunsList
        entries={[entry(0), entry(1)]}
        onClose={() => {}}
        loadSummary={summaryFor}
        now={now}
      />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('evidence-0.csv');
    expect(frame).toContain(DETAIL_HINTS);
    expectNoOverflow(frame, 44);
    unmount();
  });

  it('a summary load failure renders inside the detail view', async () => {
    const failing = () => {
      throw new Error('no readable manifest in /runs/run-0');
    };
    const { lastFrame, stdin, unmount } = render(
      <RunsList entries={[entry(0)]} onClose={() => {}} loadSummary={failing} now={now} />,
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain("Couldn't read this run: no readable manifest in /runs/run-0");
    expect(frame).toContain(DETAIL_HINTS);
    // ← still recovers to the list.
    stdin.write(LEFT);
    await tick();
    expect(lastFrame()).toContain(LIST_HINTS);
    unmount();
  });
});
