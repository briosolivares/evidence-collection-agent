import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { createChecklistTask, updateChecklistTask } from '../../src/run/checklist.js';
import { initManifest } from '../../src/run/artifacts.js';
import type { RunHandle, RunOutcome } from '../../src/tui/bridge/runSession.js';
import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { ENTER, ESC, tick, typeText } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

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

/** A fake run that creates a real checklist task after publishing its runDir. */
function checklistRunner(runDirs: readonly string[]) {
  let nextRun = 0;
  const resolveDone: Array<(value: RunOutcome) => void> = [];
  const emitters: Array<(event: UiEvent) => void> = [];
  const runner = vi.fn((task: string, onEvent: (event: UiEvent) => void): RunHandle => {
    const runDir = runDirs[nextRun++];
    if (runDir === undefined) throw new Error('checklist test ran out of run directories');
    emitters.push(onEvent);
    onEvent({ type: 'run_started', task, at: 0 });
    onEvent({ type: 'run_dir', runDir });
    createChecklistTask(runDir, {
      subject: `${task} checklist item`,
      description: `Checklist coverage for ${task}`,
      activeForm: `Working on ${task}`,
    });
    return {
      cancel: vi.fn(),
      done: new Promise<RunOutcome>((resolve) => resolveDone.push(resolve)),
    };
  });
  return {
    runner,
    emit(index: number, event: UiEvent) {
      emitters[index]?.(event);
    },
    finish(index: number, outcome: RunOutcome = { status: 'cancelled' }) {
      resolveDone[index]?.(outcome);
    },
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

  it('observes a real checklist create/update while the run is active', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-live-'));
    try {
      initManifest(runDir, 'checklist live task');
      const bridge = checklistRunner([runDir]);
      const { frames, stdin, unmount } = render(
        <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
      );
      await tick();
      await submitLine(stdin, 'collect filing evidence');
      updateChecklistTask(runDir, '1', { status: 'in_progress' });
      await tick(180);

      const output = frames.join('\n');
      expect(output).toContain('Working on collect filing evidence');
      expect(output).toContain('collect filing evidence checklist item');
      bridge.finish(0);
      unmount();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps an incomplete checklist above the composer after cancellation', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-cancel-'));
    try {
      initManifest(runDir, 'checklist cancellation task');
      const bridge = checklistRunner([runDir]);
      const { lastFrame, stdin, unmount } = render(
        <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
      );
      await tick();
      await submitLine(stdin, 'cancelled checklist');
      bridge.emit(0, { type: 'run_cancelled', at: 18_000 });
      bridge.finish(0);
      await tick(120);

      expect(lastFrame()).toContain('cancelled checklist checklist item');
      expect(lastFrame()).toContain('Checklist');
      unmount();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps an incomplete checklist above the composer after budget termination', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-budget-'));
    try {
      initManifest(runDir, 'checklist budget task');
      const bridge = checklistRunner([runDir]);
      const { lastFrame, stdin, unmount } = render(
        <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
      );
      await tick();
      await submitLine(stdin, 'budget checklist');
      bridge.emit(0, {
        type: 'run_finished',
        outcome: 'budget_exceeded',
        reason: 'max_turns',
        runDir,
        at: 18_000,
      });
      bridge.finish(0, { status: 'budget_exceeded', reason: 'max_turns', runDir });
      await tick(120);

      expect(lastFrame()).toContain('budget checklist checklist item');
      expect(lastFrame()).toContain('Checklist');
      unmount();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('hides the idle checklist behind the /runs overlay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-overlay-'));
    const runDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-overlay-run-'));
    try {
      initManifest(runDir, 'checklist overlay task');
      const overlayConfig = createConfig({ runsBaseDir: join(root, 'runs') });
      const bridge = checklistRunner([runDir]);
      const { lastFrame, stdin, unmount } = render(
        <App config={overlayConfig} apiKeyPresent={true} runner={bridge.runner} />,
      );
      await tick();
      await submitLine(stdin, 'overlay checklist');
      bridge.emit(0, { type: 'run_cancelled', at: 18_000 });
      bridge.finish(0);
      await tick(120);
      expect(lastFrame()).toContain('overlay checklist checklist item');

      await submitLine(stdin, '/runs');
      expect(lastFrame()).toContain('No runs yet');
      expect(lastFrame()).not.toContain('overlay checklist checklist item');
      unmount();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('clears the previous checklist when a new run starts', async () => {
    const firstRunDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-first-'));
    const secondRunDir = mkdtempSync(join(tmpdir(), 'sherlock-app-checklist-second-'));
    try {
      initManifest(firstRunDir, 'first checklist task');
      initManifest(secondRunDir, 'second checklist task');
      const bridge = checklistRunner([firstRunDir, secondRunDir]);
      const { frames, lastFrame, stdin, unmount } = render(
        <App config={config} apiKeyPresent={true} runner={bridge.runner} />,
      );
      await tick();
      await submitLine(stdin, 'first run');
      bridge.emit(0, { type: 'run_cancelled', at: 18_000 });
      bridge.finish(0);
      await tick(120);
      expect(lastFrame()).toContain('first run checklist item');

      await submitLine(stdin, 'second run');
      await tick(120);
      expect(lastFrame()).toContain('second run checklist item');
      expect(lastFrame()).not.toContain('first run checklist item');
      expect(frames.join('\n')).toContain('first run checklist item');
      bridge.finish(1);
      unmount();
    } finally {
      rmSync(firstRunDir, { recursive: true, force: true });
      rmSync(secondRunDir, { recursive: true, force: true });
    }
  });
});

// ————— Step 7: /runs overlay —————

describe('App /runs browsing', () => {
  it('/runs browses list ↔ detail with arrows through the real reducer', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeFixtureRun } = await import('./runFixtures.js');

    const DOWN = '\u001b[B';
    const UP = '\u001b[A';
    const LEFT = '\u001b[D';

    const baseDir = mkdtempSync(join(tmpdir(), 'sherlock-app-runs-'));
    try {
      // Newest first: ids sort lexically descending.
      writeFixtureRun(baseDir, {
        id: '2026-08-11T11-00-00-000Z-new',
        task: 'the newest investigation',
        startedAt: '2026-08-11T11:00:00.000Z',
        finishedAt: '2026-08-11T11:01:24.000Z',
        metrics: { status: 'completed', turns: 4, inputTokens: 30_000, outputTokens: 1_200, cacheReadInputTokens: 0, wallClockMs: 84_000 },
        artifacts: [
          {
            filename: 'artifacts/out.csv',
            content: 'a,b\n',
            sha256: 'feedfacedead0000',
            roles: ['requested_output'],
          },
        ],
      });
      writeFixtureRun(baseDir, {
        id: '2026-08-11T10-00-00-000Z-old',
        task: 'the older investigation',
        startedAt: '2026-08-11T10:00:00.000Z',
        finishedAt: '2026-08-11T10:00:30.000Z',
        artifacts: [
          {
            filename: 'artifacts/page.png',
            content: 'png-bytes',
            sha256: 'cafebabe12340000',
            roles: ['evidence'],
          },
        ],
      });

      const runsConfig = createConfig({ runsBaseDir: baseDir });
      const { frames, lastFrame, stdin, unmount } = render(
        <App config={runsConfig} apiKeyPresent={true} />,
      );
      await tick();
      await submitLine(stdin, '/runs');
      expect(lastFrame()).toContain('Past runs');
      expect(lastFrame()).toContain('the newest investigation');
      expect(lastFrame()).toContain('the older investigation');

      // ↓ then Enter opens the older run's detail inside the overlay.
      stdin.write(DOWN);
      await tick();
      stdin.write('\r');
      await tick();
      expect(lastFrame()).toContain('sha256 cafebabe1234');
      expect(lastFrame()).toContain('page.png');
      expect(lastFrame()).toContain('↑↓ prev/next run · ← back · esc back');

      // ↑ jumps straight to the newer run's detail (real loadRunSummary).
      stdin.write(UP);
      await tick();
      expect(lastFrame()).toContain('sha256 feedfacedead');
      expect(lastFrame()).toContain('1m 24s');
      stdin.write(DOWN); // and back down to the older one
      await tick();
      expect(lastFrame()).toContain('sha256 cafebabe1234');

      // ← returns to the list with the cursor still on the older run.
      stdin.write(LEFT);
      await tick();
      expect(lastFrame()).toContain('↑↓ select · enter view · esc close');
      expect(lastFrame()).toContain('› ✗ the older investigation');

      // Esc from the list closes the overlay; nothing was appended to the
      // transcript, and the composer is usable again.
      stdin.write(ESC);
      await tick(150);
      expect(lastFrame()).not.toContain('Past runs');
      expect(lastFrame()).not.toContain('sha256');
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

// ————— Step 8: /evals workflow —————

describe('App /evals workflow', () => {
  it('/evals opens the menu; a confirmed selection streams trials through the live pipeline', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const resultsDir = mkdtempSync(join(tmpdir(), 'sherlock-app-eval-results-'));
    try {
      // The repo's real, hermetic `stub` eval task: static oracle, and a
      // grader that returns failed assertions (never throws) for a run
      // dir that does not exist.
      const evalsConfig = createConfig({ evalsDir: 'evals/datasets', evalResultsDir: resultsDir });
      const bridge = fakeRunner();
      const runner = vi.fn(
        (task: string, onEvent: (event: UiEvent) => void): RunHandle => {
          onEvent({ type: 'run_started', task, at: 0 });
          onEvent({ type: 'turn_start', turn: 1 });
          onEvent({ type: 'text_delta', text: 'Investigating for the eval…' });
          onEvent({ type: 'turn_end', usage: { input: 500, output: 100 } });
          onEvent({
            type: 'run_finished',
            outcome: 'completed',
            finalText: 'done',
            runDir: '/runs/eval-trial',
            at: 9_000,
          });
          return {
            cancel: bridge.cancel,
            done: Promise.resolve({
              status: 'completed',
              finalText: 'done',
              runDir: '/runs/eval-trial',
            }),
          };
        },
      );

      const { frames, lastFrame, stdin, unmount } = render(
        <App config={evalsConfig} apiKeyPresent={true} runner={runner} />,
      );
      await tick();
      await submitLine(stdin, '/evals');
      expect(lastFrame()).toContain('Eval tasks');
      expect(lastFrame()).toContain('[ ] stub');

      // Navigate to `stub` (tasks list alphabetically) and select it.
      while (!(lastFrame() ?? '').includes('\u203a [ ] stub')) {
        stdin.write('\u001b[B');
        await tick();
      }
      stdin.write(' '); // select stub
      await tick();
      expect(lastFrame()).toContain('[x] stub');
      stdin.write('\r'); // to k stage
      await tick();
      expect(lastFrame()).toContain('k: 3');
      stdin.write('\u007f'); // clear the default 3
      await tick();
      stdin.write('1');
      await tick();
      stdin.write('\r'); // start k=1
      await tick(200);

      const output = frames.join('\n');
      // Trial framing + the run streamed through the same live pipeline.
      expect(output).toContain('— stub · trial 1/1 —');
      expect(output).toContain('Investigating for the eval…');
      expect(output).toContain('Brewed in');
      expect(output).toContain('/runs/eval-trial');
      // Verdicts and the report block landed as transcript items.
      expect(output).toContain('answer.md missing from run dir');
      expect(output).toContain('Eval report — k=1');
      expect(runner).toHaveBeenCalledTimes(1);
      // Batch finished: composer is back.
      expect(lastFrame()).not.toContain('evals running');
      unmount();
    } finally {
      rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it('/evals without a runner explains itself', async () => {
    const { frames, stdin, unmount } = render(
      <App config={config} apiKeyPresent={true} />,
    );
    await tick();
    await submitLine(stdin, '/evals');
    expect(frames.join('\n')).toContain('not available in --demo');
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
