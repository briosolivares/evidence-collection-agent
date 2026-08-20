import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import type { RunHandle } from '../../src/tui/bridge/runSession.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { ENTER, ESC, tick, typeText } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const config = createConfig();
const CTRL_C = '\u0003';

describe('preflight and exit paths', () => {
  it('renders the missing-key banner when no API key is present', async () => {
    const { frames, unmount } = render(createElement(App, { config, apiKeyPresent: false }));
    await tick();
    expect(frames.join('\n')).toContain('ANTHROPIC_API_KEY is not set');
    unmount();
  });

  it('non-TTY startup fails with one line and a non-zero exit status', () => {
    let failed = false;
    let stderr = '';
    try {
      // stdin/stdout are pipes here — exactly the non-TTY case.
      execFileSync('node', ['bin/sherlock.mjs'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (error) {
      failed = true;
      stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    }
    expect(failed).toBe(true);
    const lines = stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/interactive terminal|TTY/i);
  });

  it('soft interrupt, cancel, repeated Esc, and Ctrl+C stay safe', async () => {
    const cancel = vi.fn();
    let emit: ((event: UiEvent) => void) | undefined;
    const runner = vi.fn((task: string, onEvent: (event: UiEvent) => void): RunHandle => {
      emit = onEvent;
      onEvent({ type: 'run_started', task, at: 0 });
      return { cancel, done: new Promise(() => {}) };
    });

    const { lastFrame, stdin, unmount } = render(
      createElement(App, { config, apiKeyPresent: true, runner }),
    );
    await tick();
    await typeText(stdin, 'long task');
    stdin.write(ENTER);
    await tick();

    stdin.write(ESC);
    await tick(150);
    expect(lastFrame()).toContain('Paused for your update…');
    expect(cancel).not.toHaveBeenCalled();
    stdin.write(ESC);
    await tick(150);
    expect(lastFrame()).toContain('Wrapping up…');
    stdin.write(ESC); // repeated Esc: no second cancel, still cancelling
    await tick(150);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Wrapping up…');

    // Ctrl+C is not intercepted by the App (Ink's exitOnCtrlC owns it);
    // in the test harness it must neither crash nor re-trigger cancel.
    stdin.write(CTRL_C);
    await tick();
    expect(cancel).toHaveBeenCalledTimes(1);

    // The run finally lands as cancelled and the composer returns.
    emit?.({ type: 'run_cancelled', at: 18_000 });
    await tick();
    expect(lastFrame()).not.toContain('Wrapping up…');
    unmount();
  });
});
