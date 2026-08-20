import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { RunHandle, RunOutcome } from '../../src/tui/bridge/runSession.js';
import type { PermissionDecision, PermissionRequest } from '../../src/tools/registry.js';
import { App } from '../../src/tui/components/App.js';
import { createConfig } from '../../src/tui/config.js';
import { createInitialState, reduce } from '../../src/tui/store/reducer.js';
import type { UiEvent } from '../../src/tui/store/state.js';
import { DOWN, ENTER, ESC, tick, typeText } from './helpers.js';

// Interaction-heavy suites type through a fake stdin tick by tick and
// can exceed the 5 s default under full-suite parallel load.
vi.setConfig({ testTimeout: 30_000 });

const config = createConfig();

/** A fake runner that stays live forever and exposes the App-provided
 * requestPermission callback, so tests can pose questions on demand. */
function interactiveRunner() {
  let requestPermission: ((request: PermissionRequest) => Promise<PermissionDecision>) | undefined;
  const runner = (
    _task: string,
    onEvent: (event: UiEvent) => void,
    opts?: {
      startUrl?: string;
      requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
    },
  ): RunHandle => {
    requestPermission = opts?.requestPermission;
    onEvent({ type: 'run_started', task: _task, at: 0 });
    return { cancel: () => {}, done: new Promise<RunOutcome>(() => {}) };
  };
  return {
    runner,
    ask: (input: unknown) => {
      if (requestPermission === undefined) {
        throw new Error('runner was not called with requestPermission');
      }
      return requestPermission({ toolName: 'ask_user', input });
    },
  };
}

async function startRunWithQuestion(input: unknown) {
  const fake = interactiveRunner();
  const rendered = render(<App config={config} apiKeyPresent={true} runner={fake.runner} />);
  await tick();
  await typeText(rendered.stdin, 'investigate the login');
  rendered.stdin.write(ENTER);
  await tick();
  const decision = fake.ask(input);
  // Two settles: one for the setState commit, one for the dialog's input
  // hooks to subscribe — a key written earlier lands before the dialog
  // listens and is silently dropped.
  await tick();
  await tick(10);
  return { ...rendered, decision };
}

describe('QuestionDialog in the App', () => {
  it('renders the question, context, and options above the composer', async () => {
    const { lastFrame, decision, stdin, unmount } = await startRunWithQuestion({
      question: 'Complete the login in the browser window, then tell me.',
      context: 'Use the already-open account; do not create a new one.',
      options: [{ label: 'Done', description: 'I logged in' }, { label: 'Skip it' }],
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Complete the login in the browser window');
    expect(frame).toContain('Use the already-open account');
    expect(frame).toContain('Done');
    expect(frame).toContain('I logged in');
    expect(frame).toContain('Skip it');
    expect(frame).toContain('(answer the question above)');

    // Settle the pending promise so nothing dangles.
    stdin.write(ESC);
    await decision;
    unmount();
  });

  it('submits typed free text as the answer', async () => {
    const { decision, stdin, lastFrame, unmount } = await startRunWithQuestion({
      question: 'Tell me when you are done.',
    });

    await typeText(stdin, 'done, there was an email code');
    stdin.write(ENTER);

    await expect(decision).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        question: 'Tell me when you are done.',
        answers: { chosen: [], freeText: 'done, there was an email code' },
      },
    });
    await tick();
    expect(lastFrame()).not.toContain('Tell me when you are done.');
    unmount();
  });

  it('submits the highlighted option on Enter with no text', async () => {
    const { decision, stdin, unmount } = await startRunWithQuestion({
      question: 'Proceed?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    });

    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);

    await expect(decision).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        question: 'Proceed?',
        options: [{ label: 'Yes' }, { label: 'No' }],
        answers: { chosen: ['No'] },
      },
    });
    unmount();
  });

  it('Esc denies with the fixed dismissal feedback and the run continues', async () => {
    const { decision, stdin, lastFrame, unmount } = await startRunWithQuestion({
      question: 'Proceed?',
    });

    stdin.write(ESC);

    await expect(decision).resolves.toEqual({
      behavior: 'deny',
      feedback:
        'The user dismissed the question. Continue without this ' +
        'information or finish the task.',
    });
    await tick();
    // The run is still live — dismissing the dialog is not a cancel.
    expect(lastFrame()).toContain('(waiting for agent…)');
    unmount();
  });
});

describe('permission_request in the reducer', () => {
  it('finalizes streaming prose and keeps the run live', () => {
    let state = createInitialState();
    state = reduce(state, { type: 'run_started', task: 'ask me', at: 0 });
    state = reduce(state, { type: 'text_delta', text: 'One question first.' });
    state = reduce(state, {
      type: 'permission_request',
      toolName: 'ask_user',
      input: { question: 'Hm?' },
    });

    expect(
      state.transcript.some(
        (item) => item.kind === 'agent_text' && item.text === 'One question first.',
      ),
    ).toBe(true);
    expect(state.live?.streamingText).toBe('');
    expect(state.mode).toBe('running');
  });
});
