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
