import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { RunsList } from '../../src/tui/components/RunsList.js';
import { TranscriptItemView } from '../../src/tui/components/TranscriptItem.js';
import type { RunListEntry } from '../../src/tui/runScanner.js';
import { ESC, tick } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const DOWN = '\u001b[B';
const UP = '\u001b[A';
const ENTER = '\r';

function entry(index: number, status: RunListEntry['status'] = 'complete'): RunListEntry {
  return {
    runDir: `/runs/run-${index}`,
    id: `run-${index}`,
    task: `task number ${index}`,
    startedAt: new Date(1_754_900_000_000 - index * 3_600_000).toISOString(),
    status,
  };
}

const now = () => 1_754_900_000_000;

describe('RunsList', () => {
  it('renders rows with status glyphs and relative dates', async () => {
    const entries = [entry(0, 'complete'), entry(1, 'unfinished'), entry(2, 'stopped')];
    const { lastFrame, unmount } = render(
      <RunsList entries={entries} onSelect={() => {}} onClose={() => {}} now={now} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓ task number 0');
    expect(frame).toContain('◐ task number 1');
    expect(frame).toContain('✗ task number 2');
    expect(frame).toContain('1h ago');
    expect(frame).not.toContain('crash');
    unmount();
  });

  it('windows long lists and scrolls with the cursor', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => entry(index));
    const { lastFrame, stdin, unmount } = render(
      <RunsList entries={entries} onSelect={() => {}} onClose={() => {}} limit={4} now={now} />,
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

  it('Enter selects the highlighted run', async () => {
    const entries = [entry(0), entry(1)];
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <RunsList entries={entries} onSelect={onSelect} onClose={() => {}} now={now} />,
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(entries[1]);
    unmount();
  });

  it('Esc closes the overlay', async () => {
    const onClose = vi.fn();
    const { stdin, unmount } = render(
      <RunsList entries={[entry(0)]} onSelect={() => {}} onClose={onClose} now={now} />,
    );
    await tick();
    stdin.write(ESC);
    await tick(150);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('shows a friendly empty state', async () => {
    const { lastFrame, unmount } = render(
      <RunsList entries={[]} onSelect={() => {}} onClose={() => {}} now={now} />,
    );
    await tick();
    expect(lastFrame()).toContain('No runs yet');
    unmount();
  });
});

describe('run summary rendering', () => {
  it('shows task, duration, tokens, artifact size and sha256 prefix', async () => {
    const { frames, unmount } = render(
      <TranscriptItemView
        item={{
          id: 1,
          kind: 'run_summary',
          runDir: '/runs/xyz',
          manifest: {
            task: 'summarize me',
            startedAt: '2026-08-11T10:00:00.000Z',
            finishedAt: '2026-08-11T10:01:24.000Z',
            artifacts: [
              {
                filename: 'top5.csv',
                sizeBytes: 2_048,
                sha256Prefix: 'deadbeefcafe',
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
        }}
      />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('summarize me');
    expect(output).toContain('1m 24s');
    expect(output).toContain('31.2k tokens');
    expect(output).toContain('top5.csv');
    expect(output).toContain('2.0 KB');
    expect(output).toContain('sha256 deadbeefcafe');
    expect(output).toContain('/runs/xyz');
    unmount();
  });
});
