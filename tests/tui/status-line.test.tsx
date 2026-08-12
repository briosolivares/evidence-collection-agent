import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { pickWord, StatusLine } from '../../src/tui/components/StatusLine.js';
import { TranscriptItemView } from '../../src/tui/components/TranscriptItem.js';
import { createConfig } from '../../src/tui/config.js';
import type { RunChecklistSnapshot } from '../../src/tui/hooks/useRunChecklist.js';
import type { LiveRunState } from '../../src/tui/store/state.js';
import { renderAt, tick } from './helpers.js';

function liveState(overrides: Partial<LiveRunState> = {}): LiveRunState {
  return {
    streamingText: '',
    pendingTools: [],
    nextPendingId: 1,
    startedAt: 0,
    tokens: { settled: 0, estimate: 0 },
    turn: 1,
    ...overrides,
  };
}

describe('pickWord', () => {
  const words = ['Foraging', 'Sifting', 'Rummaging'];

  it('never repeats the current word (injected RNG sweep)', () => {
    for (const current of words) {
      for (let roll = 0; roll < 10; roll++) {
        const next = pickWord(words, current, () => roll / 10);
        expect(next).not.toBe(current);
        expect(words).toContain(next);
      }
    }
  });

  it('falls back to the full list when only one word exists', () => {
    expect(pickWord(['Brewing'], 'Brewing', () => 0.5)).toBe('Brewing');
  });
});

describe('StatusLine', () => {
  it('renders inline metrics at normal width', async () => {
    const config = createConfig();
    const { lastFrame, unmount } = renderAt(
      80,
      <StatusLine
        config={config}
        live={liveState({ startedAt: 0, tokens: { settled: 12_400, estimate: 12_400 } })}
        now={() => 18_000}
        rng={() => 0}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('(18s · ↓ 12.4k tokens)');
    unmount();
  });

  it('keeps metrics on the muted metadata line at narrow width', async () => {
    const config = createConfig();
    const { lastFrame, unmount } = renderAt(
      44,
      <StatusLine
        config={config}
        live={liveState({ startedAt: 0, tokens: { settled: 12_400, estimate: 12_400 } })}
        now={() => 18_000}
        rng={() => 0}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('↳ 12.4k tokens · 18s');
    expect(lastFrame()).not.toContain('(18s · ↓ 12.4k tokens)');
    unmount();
  });

  it('wraps metrics when a long active headline leaves too little inline space', async () => {
    const { lastFrame, unmount } = renderAt(
      64,
      <StatusLine
        config={createConfig()}
        live={liveState({ tokens: { settled: 209, estimate: 209 } })}
        checklist={{
          visible: true,
          tasks: [{
            id: '1',
            subject: 'Validation',
            description: 'Validate',
            status: 'in_progress',
            activeForm: 'Running validation and writing the final report',
          }],
        }}
        now={() => 9_000}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('↳ 209 tokens · 9s');
    expect(lastFrame()).not.toContain('(9s · ↓ 209 tokens)');
    unmount();
  });

  it('uses the active task activeForm, then subject, for the running headline', async () => {
    const config = createConfig();
    const checklist: RunChecklistSnapshot = {
      visible: true,
      tasks: [{ id: '1', subject: 'Collect filing', description: 'Collect it', status: 'in_progress', activeForm: 'Collecting filing' }],
    };
    const active = render(
      <StatusLine config={config} live={liveState()} checklist={checklist} rng={() => 0} />,
    );
    await tick();
    expect(active.lastFrame()).toContain('Collecting filing…');
    active.unmount();

    const subjectFallback = render(
      <StatusLine config={config} live={liveState()} checklist={{
        visible: true,
        tasks: [{ id: '1', subject: 'Collect filing', description: 'Collect it', status: 'in_progress' }],
      }} rng={() => 0} />,
    );
    await tick();
    expect(subjectFallback.lastFrame()).toContain('Collect filing…');
    subjectFallback.unmount();
  });

  it('renders the compact checklist only when the snapshot is visible', async () => {
    const config = createConfig();
    const checklist: RunChecklistSnapshot = {
      visible: true,
      tasks: [
        { id: '1', subject: 'Collect filing', description: 'Collect it', status: 'in_progress' },
        { id: '2', subject: 'Write report', description: 'Write it', status: 'pending' },
      ],
    };
    const { lastFrame, unmount } = render(
      <StatusLine config={config} live={liveState()} checklist={checklist} rng={() => 0} />,
    );
    await tick();
    expect(lastFrame()).toContain('Collect filing');
    expect(lastFrame()).toContain('Write report');
    unmount();
  });

  it('cycles working words on the injected clock without immediate repeats', async () => {
    const config = createConfig({
      workingWords: ['Foraging', 'Sifting', 'Rummaging'],
      wordCycleMs: 40,
    });
    let roll = 0;
    const rng = () => {
      roll = (roll + 1) % 3;
      return roll / 3;
    };
    const { frames, unmount } = render(
      <StatusLine config={config} live={liveState()} now={() => 0} rng={rng} />,
    );
    await tick(260);
    unmount();
    const seen: string[] = [];
    for (const frame of frames) {
      const match = frame.match(/[✢✳✻✽] (\p{L}[\p{L} ]*)…/u);
      if (match === null) continue;
      if (seen.at(-1) !== match[1]) seen.push(match[1]!);
    }
    // Consecutive rendered words always differ, and the run cycled through
    // several distinct words.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('shows the wrapping-up phrase while cancelling', async () => {
    const config = createConfig();
    const { lastFrame, unmount } = render(
      <StatusLine
        config={config}
        live={liveState()}
        cancelling={true}
        now={() => 1_000}
        rng={() => 0}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('Wrapping up…');
    unmount();
  });
});

describe('completion line', () => {
  it('uses the configured verb with natural duration formatting', async () => {
    const { frames, unmount } = render(
      <TranscriptItemView
        item={{
          id: 1,
          kind: 'completion',
          verb: 'Distilled',
          elapsedMs: 84_000,
          tokens: 31_200,
          runDir: '/runs/xyz',
        }}
      />,
    );
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('✓ Distilled in 1m 24s · 31.2k tokens');
    expect(output).toContain('/runs/xyz');
    unmount();
  });
});
