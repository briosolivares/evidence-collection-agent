// Renders the real App in a real terminal with a scripted runner that
// pauses on ask_user_question mid-run — the PTY verification harness for
// the pause/ask/answer/resume path, needing no model and no browser.
//
// Drive it per the repo's PTY playbook, e.g.:
//   ( sleep 1; printf 'check the login wall'; sleep 0.3; printf '\r'; \
//     sleep 1.5; printf 'done, logged in'; sleep 0.3; printf '\r'; \
//     sleep 1.5; printf '\x03' ) \
//   | script -q /tmp/pty-question.txt npx tsx scripts/questionDialogPtyHarness.tsx
// then strip ANSI and inspect /tmp/pty-question.txt.

import { render } from 'ink';

import type { RunHandle, RunOutcome } from '../src/tui/bridge/runSession.js';
import type {
  PermissionDecision,
  PermissionRequest,
} from '../src/tools/registry.js';
import { App } from '../src/tui/components/App.js';
import { createConfig } from '../src/tui/config.js';
import type { UiEvent } from '../src/tui/store/state.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runner = (
  task: string,
  onEvent: (event: UiEvent) => void,
  opts?: {
    startUrl?: string;
    requestPermission?: (
      request: PermissionRequest,
    ) => Promise<PermissionDecision>;
  },
): RunHandle => {
  let resolveDone!: (outcome: RunOutcome) => void;
  const done = new Promise<RunOutcome>((resolve) => {
    resolveDone = resolve;
  });

  void (async () => {
    onEvent({ type: 'run_started', task, at: Date.now() });
    onEvent({ type: 'turn_start', turn: 1 });
    onEvent({
      type: 'text_delta',
      text: 'This login needs a human — asking now.',
    });
    await sleep(300);

    const decision = await opts!.requestPermission!({
      toolName: 'ask_user_question',
      input: {
        question:
          'Please complete the login in the browser window, then tell me.',
        header: 'Login',
        options: [
          { label: 'Done', description: 'I completed the login' },
          { label: 'Skip', description: 'Continue without logging in' },
        ],
      },
    });

    onEvent({
      type: 'text_delta',
      text: `Runner observed: ${JSON.stringify(decision)}`,
    });
    await sleep(300);
    onEvent({ type: 'turn_end', usage: { input: 1200, output: 60 } });
    onEvent({
      type: 'run_finished',
      outcome: 'verified',
      finalText: 'Resumed after the human handoff and finished.',
      runDir: '/tmp/pty-harness-run',
      at: Date.now(),
    });
    resolveDone({
      status: 'verified',
      finalText: 'Resumed after the human handoff and finished.',
      runDir: '/tmp/pty-harness-run',
    });
  })();

  return { cancel: () => {}, done };
};

render(<App config={createConfig()} apiKeyPresent={true} runner={runner} />);
