import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { Transcript } from '../../src/tui/components/Transcript.js';
import type { TranscriptItem, TranscriptItemBody } from '../../src/tui/store/state.js';
import { tick } from './helpers.js';

function items(...entries: TranscriptItemBody[]): TranscriptItem[] {
  return entries.map((entry, index) => ({ ...entry, id: index }));
}

describe('Transcript', () => {
  it('renders user tasks with the ▸ marker', async () => {
    const { frames, unmount } = render(
      <Transcript items={items({ kind: 'user_task', text: 'find the filings' })} />,
    );
    await tick();
    expect(frames.join('\n')).toContain('▸ find the filings');
    unmount();
  });

  it('renders notices', async () => {
    const { frames, unmount } = render(
      <Transcript items={items({ kind: 'notice', text: 'a gentle notice' })} />,
    );
    await tick();
    expect(frames.join('\n')).toContain('a gentle notice');
    unmount();
  });

  it('hides raw input/result detail by default and shows it in verbose mode', async () => {
    const activityItems = items({
      kind: 'activity',
      line: 'Searching files for "Q3"',
      status: 'ok',
      verbose: { input: '{"pattern":"Q3"}', result: 'notes.md:4: Q3 revenue' },
    });

    const plain = render(<Transcript items={activityItems} />);
    await tick();
    const plainOutput = plain.frames.join('\n');
    expect(plainOutput).toContain('Searching files for "Q3"');
    expect(plainOutput).not.toContain('{"pattern":"Q3"}');
    plain.unmount();

    const verbose = render(<Transcript items={activityItems} verbose={true} />);
    await tick();
    const verboseOutput = verbose.frames.join('\n');
    expect(verboseOutput).toContain('input: {"pattern":"Q3"}');
    expect(verboseOutput).toContain('result: notes.md:4: Q3 revenue');
    verbose.unmount();
  });

  it('renders evidence items with their source line', async () => {
    const { frames, unmount } = render(
      <Transcript
        items={items({
          kind: 'evidence',
          line: 'Evidence saved → top5.csv',
          sourceUrl: 'https://news.ycombinator.com/',
        })}
      />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('◆ Evidence saved → top5.csv');
    expect(output).toContain('source: https://news.ycombinator.com/');
    unmount();
  });

  it('renders the completion artifact digest under the ✓ line', async () => {
    const { frames, unmount } = render(
      <Transcript
        items={items({
          kind: 'completion',
          verb: 'Brewed',
          elapsedMs: 42_000,
          tokens: 18_700,
          runDir: '/runs/abc',
          artifacts: [
            { filename: 'artifacts/top5.csv', sizeBytes: 96, roles: ['requested_output'] },
            { filename: 'artifacts/page.png', sizeBytes: 2_048, roles: ['evidence'] },
            { filename: 'artifacts/odd.bin', sizeBytes: undefined, roles: [] },
          ],
        })}
      />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('✓ Brewed in 42s · 18.7k tokens');
    expect(output).toContain('◆ artifacts/top5.csv · 96 B · requested output');
    expect(output).toContain('◆ artifacts/page.png · 2.0 KB · evidence');
    // No stat and no roles degrade gracefully, never render "undefined".
    expect(output).toContain('◆ artifacts/odd.bin · ?');
    expect(output).not.toContain('undefined');
    expect(output).toContain('/runs/abc');
    unmount();
  });

  it('keeps earlier items visible as later items append (persistence)', async () => {
    const first = items({ kind: 'user_task', text: 'first investigation' });
    const { frames, rerender, unmount } = render(<Transcript items={first} />);
    await tick();
    rerender(
      <Transcript
        items={[
          ...first,
          { id: 1, kind: 'user_task', text: 'second investigation' },
        ]}
      />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('first investigation');
    expect(output).toContain('second investigation');
    unmount();
  });
});
