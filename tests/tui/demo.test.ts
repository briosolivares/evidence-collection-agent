import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Transcript } from '../../src/tui/components/Transcript.js';
import { createDemoScript, playDemo } from '../../src/tui/demo.js';
import { createInitialState, reduce } from '../../src/tui/store/reducer.js';
import type { StoreAction } from '../../src/tui/store/reducer.js';

describe('the --demo scripted event source', () => {
  it('is finite and ends the run back in idle mode', () => {
    const script = createDemoScript(0);
    expect(script.length).toBeGreaterThan(10);
    const final = script.reduce(
      (state, step) => reduce(state, step.action),
      createInitialState(),
    );
    expect(final.mode).toBe('idle');
    expect(final.live).toBeUndefined();
  });

  it('renders a final transcript containing `✓ Brewed in 42s · 18.7k tokens`', async () => {
    const final = createDemoScript(0).reduce(
      (state, step) => reduce(state, step.action),
      createInitialState(),
    );
    const { frames, unmount } = render(
      createElement(Transcript, { items: final.transcript }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = frames.join('\n');
    expect(output).toContain('✓ Brewed in 42s · 18.7k tokens');
    expect(output).toContain('▸ Find Acme Corp');
    expect(output).toContain('● Opening techcrunch.com/');
    expect(output).toContain('◆ Captured series-b-coverage.png');
    expect(output).toContain('◆ Evidence saved → investors.csv');
    unmount();
  });

  it('publishes a believable artifact set: two sourced screenshots + the CSV', () => {
    const final = createDemoScript(0).reduce(
      (state, step) => reduce(state, step.action),
      createInitialState(),
    );
    // Publish order (the live rail's order); the CSV is the sole
    // requested output, so the summary surfaces reorder it first.
    expect(final.artifacts.map((artifact) => artifact.entry.filename)).toEqual([
      'artifacts/series-b-coverage.png',
      'artifacts/form-d-filing.png',
      'artifacts/investors.csv',
    ]);
    const roles = final.artifacts.map((artifact) => artifact.entry.roles);
    expect(roles).toEqual([['evidence'], ['evidence'], ['requested_output']]);
    // The browsing turns' captures carry their source URLs into the rail.
    expect(final.artifacts[0]!.entry.sourceUrl).toContain('techcrunch.com');
    expect(final.artifacts[1]!.entry.sourceUrl).toContain('sec.gov');
    // Every publish lands as a finalized ◆ evidence transcript item.
    const evidence = final.transcript.filter((item) => item.kind === 'evidence');
    expect(evidence).toHaveLength(3);
  });

  it('records a completion summary with a real answer for the panel', () => {
    const final = createDemoScript(0).reduce(
      (state, step) => reduce(state, step.action),
      createInitialState(),
    );
    expect(final.completedRun).toBeDefined();
    expect(final.completedRun!.finalText).toContain('Meridian Growth');
    expect(final.completedRun!.finalText).toContain('investors.csv');
    // The transcript's inert digest mirrors it, requested outputs first.
    const completion = final.transcript.find((item) => item.kind === 'completion');
    expect(
      completion?.kind === 'completion'
        ? completion.artifacts.map((artifact) => artifact.filename)
        : [],
    ).toEqual([
      'artifacts/investors.csv',
      'artifacts/series-b-coverage.png',
      'artifacts/form-d-filing.png',
    ]);
  });

  it('streams prose, runs tool batches, and survives an errored call', () => {
    const final = createDemoScript(0).reduce(
      (state, step) => reduce(state, step.action),
      createInitialState(),
    );
    const kinds = final.transcript.map((item) => item.kind);
    expect(kinds).toContain('agent_text');
    expect(kinds).toContain('activity');
    const activities = final.transcript.filter((item) => item.kind === 'activity');
    expect(activities.some((item) => item.status === 'error')).toBe(true);
    expect(activities.some((item) => item.status === 'ok')).toBe(true);
  });

  it('playDemo dispatches every step in order and honors cancellation', async () => {
    vi.useFakeTimers();
    try {
      const script = createDemoScript(0).slice(0, 5).map((step) => ({
        ...step,
        delayMs: 1,
      }));
      const seen: StoreAction[] = [];
      const cancel = playDemo(script, (action) => seen.push(action));
      await vi.runAllTimersAsync();
      expect(seen).toEqual(script.map((step) => step.action));

      const seenAfterCancel: StoreAction[] = [];
      const cancelEarly = playDemo(script, (action) => seenAfterCancel.push(action));
      cancelEarly();
      await vi.runAllTimersAsync();
      expect(seenAfterCancel).toEqual([]);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
