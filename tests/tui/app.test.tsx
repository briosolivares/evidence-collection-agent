import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { RunHandle, RunOutcome } from '../../src/tui/bridge/runSession.js';
import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { ENTER, ESC, tick, typeText } from './helpers.js';

const config = createConfig();

async function submitLine(
  stdin: { write: (data: string) => void },
  line: string,
): Promise<void> {
  await typeText(stdin, line);
  stdin.write(ENTER);
  await tick();
}

describe('App slash routing and transcript', () => {
  it('appends submitted tasks and keeps earlier entries visible', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, 'first investigation');
    await submitLine(stdin, 'second investigation');
    const output = frames.join('\n');
    expect(output).toContain('▸ first investigation');
    expect(output).toContain('▸ second investigation');
    unmount();
  });

  it('/help renders the command list and keys', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/help');
    const output = frames.join('\n');
    expect(output).toContain('/runs');
    expect(output).toContain('/evals');
    expect(output).toContain('/exit');
    expect(output).toContain('Esc');
    unmount();
  });

  it('unknown commands get a gentle notice', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/frobnicate');
    const output = frames.join('\n');
    expect(output).toContain("/frobnicate isn't a command I know");
    expect(output).toContain('/help');
    unmount();
  });

  it('/exit exits through the app lifecycle', async () => {
    const onExit = vi.fn();
    const { stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} onExit={onExit} />,
    );
    await tick();
    await submitLine(stdin, '/exit');
    expect(onExit).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ————— Step 4: run-session bridge wiring —————

/** A controllable fake bridge: emits scripted events on demand. */
function fakeRunner(outcome: RunOutcome = { status: 'cancelled' }) {
  let emit: ((event: UiEvent) => void) | undefined;
  let resolveDone: ((value: RunOutcome) => void) | undefined;
  const cancel = vi.fn();
  const runner = vi.fn((task: string, onEvent: (event: UiEvent) => void): RunHandle => {
    emit = onEvent;
    onEvent({ type: 'run_started', task, at: 0 });
    return {
      cancel,
      done: new Promise<RunOutcome>((resolve) => {
        resolveDone = resolve;
      }),
    };
  });
  return {
    runner,
    cancel,
    emit: (event: UiEvent) => emit?.(event),
    finish: () => resolveDone?.(outcome),
  };
}

describe('App run-session wiring', () => {
  it('submitting a task invokes the bridge and disables the composer', async () => {
    const bridge = fakeRunner();
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
    );
    await tick();
    await submitLine(stdin, 'collect the filings');
    expect(bridge.runner).toHaveBeenCalledTimes(1);
    expect(bridge.runner.mock.calls[0]?.[0]).toBe('collect the filings');
    expect(lastFrame()).toContain('(waiting for agent…)');
    expect(frames.join('\n')).toContain('▸ collect the filings');
    unmount();
  });

  it('renders the completed run directory and re-enables the composer', async () => {
    const bridge = fakeRunner();
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
    );
    await tick();
    await submitLine(stdin, 'quick task');
    bridge.emit({ type: 'turn_start', turn: 1 });
    bridge.emit({ type: 'text_delta', text: 'On it.' });
    bridge.emit({ type: 'turn_end', usage: { input: 900, output: 100 } });
    bridge.emit({
      type: 'run_finished',
      outcome: 'completed',
      finalText: 'On it.',
      runDir: '/runs/2026-08-11_quick',
      at: 42_000,
    });
    bridge.finish();
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('/runs/2026-08-11_quick');
    expect(output).toContain('Brewed in');
    expect(lastFrame()).not.toContain('(waiting for agent…)');
    unmount();
  });

  it('keeps --demo working without a runner', async () => {
    const { frames, unmount } = render(
      <App config={config} apiKeyPresent={true} demo={true} />,
    );
    await tick(750);
    expect(frames.join('\n')).toContain("▸ Find Acme Corp's Series B investors");
    unmount();
  });

  it('without a runner, tasks append to the transcript and stay idle', async () => {
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, 'no bridge here');
    expect(frames.join('\n')).toContain('▸ no bridge here');
    expect(lastFrame()).not.toContain('(waiting for agent…)');
    unmount();
  });
});

// ————— Step 7: /runs overlay —————

describe('App /runs browsing', () => {
  it('/runs opens the overlay and a selection appends an inline summary', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeFixtureRun } = await import('./runFixtures.js');

    const baseDir = mkdtempSync(join(tmpdir(), 'sherlock-app-runs-'));
    try {
      writeFixtureRun(baseDir, {
        id: '2026-08-11T10-00-00-000Z-xyz',
        task: 'the summarized investigation',
        startedAt: '2026-08-11T10:00:00.000Z',
        finishedAt: '2026-08-11T10:01:24.000Z',
        metrics: { status: 'completed', turns: 4, inputTokens: 30_000, outputTokens: 1_200, cacheReadInputTokens: 0, wallClockMs: 84_000 },
        artifacts: [
          { filename: 'out.csv', content: 'a,b\n', sha256: 'feedfacedead0000' },
        ],
      });

      const runsConfig = createConfig({ runsBaseDir: baseDir });
      const { frames, lastFrame, stdin, unmount } = render(
        <App config={runsConfig} apiKeyPresent={true} />,
      );
      await tick();
      await submitLine(stdin, '/runs');
      expect(lastFrame()).toContain('Past runs');
      expect(lastFrame()).toContain('the summarized investigation');

      stdin.write('\r'); // select the only entry
      await tick();
      const output = frames.join('\n');
      expect(output).toContain('sha256 feedfacedead');
      expect(output).toContain('1m 24s');
      // Back at the composer, overlay gone.
      expect(lastFrame()).not.toContain('Past runs');
      await submitLine(stdin, 'next question');
      expect(frames.join('\n')).toContain('▸ next question');
      unmount();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('Esc closes the overlay without a summary', async () => {
    const runsConfig = createConfig({ runsBaseDir: '/nonexistent-runs-dir' });
    const { lastFrame, stdin, unmount } = render(
      <App config={runsConfig} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/runs');
    expect(lastFrame()).toContain('No runs yet');
    stdin.write(ESC);
    await tick(150);
    expect(lastFrame()).not.toContain('Past runs');
    expect(lastFrame()).toContain('›');
    unmount();
  });
});

// ————— Step 5: Esc cancellation —————

describe('App Esc cancellation', () => {
  it('Esc is a no-op while idle', async () => {
    const bridge = fakeRunner();
    const { stdin, lastFrame, unmount } = render(
      <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
    );
    await tick();
    stdin.write(ESC);
    await tick();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('›');
    unmount();
  });

  it('Esc during a run cancels once and shows the wrapping-up state', async () => {
    const bridge = fakeRunner();
    const { stdin, lastFrame, unmount } = render(
      <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
    );
    await tick();
    await submitLine(stdin, 'a long investigation');
    stdin.write(ESC);
    await tick(150);
    stdin.write(ESC); // double-Esc while already cancelling
    await tick(150);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Wrapping up…');
    unmount();
  });

  it('after cancellation the transcript keeps the interrupted line and the composer returns', async () => {
    const bridge = fakeRunner();
    const { frames, lastFrame, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
    );
    await tick();
    await submitLine(stdin, 'to be interrupted');
    bridge.emit({ type: 'turn_start', turn: 1 });
    bridge.emit({ type: 'turn_end', usage: { input: 9_000, output: 300 } });
    stdin.write(ESC);
    await tick();
    bridge.emit({ type: 'run_cancelled', at: 18_000 });
    bridge.finish();
    await tick();
    const output = frames.join('\n');
    expect(output).toContain('Interrupted after 18s · 9.3k tokens');
    expect(lastFrame()).not.toContain('(waiting for agent…)');
    // The next task can be typed immediately.
    await submitLine(stdin, 'next task');
    expect(frames.join('\n')).toContain('▸ next task');
    unmount();
  });
});
