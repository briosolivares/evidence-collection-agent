import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

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
    expect(output).toContain('navigate');
    unmount();
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
    const script = createDemoScript(0).slice(0, 5).map((step) => ({
      ...step,
      delayMs: 1,
    }));
    const seen: StoreAction[] = [];
    const cancel = playDemo(script, (action) => seen.push(action));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual(script.map((step) => step.action));

    const seenAfterCancel: StoreAction[] = [];
    const cancelEarly = playDemo(script, (action) => seenAfterCancel.push(action));
    cancelEarly();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seenAfterCancel).toEqual([]);
    cancel();
  });
});
