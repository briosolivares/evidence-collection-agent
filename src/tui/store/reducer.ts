// Pure state management for the Sherlock session: slash-input routing and
// the reducer that folds actions/events into transcript items. No Ink
// imports — everything here is unit-testable with plain data.

import type {
  SessionState,
  TranscriptItemBody,
  UiEvent,
} from './state.js';

/** UI-originated actions (composer submits, slash-command output). */
export type UiAction =
  | { type: 'submit_task'; text: string }
  | { type: 'notice'; text: string };

/** Everything the reducer consumes. */
export type StoreAction = UiAction | UiEvent;

/** Where a submitted line should go, decided purely from its text. */
export type RoutedInput =
  | { kind: 'task'; text: string }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'unknown'; command: string };

/** The /help transcript block: commands and keys (R10). */
export const HELP_TEXT = [
  'Commands',
  '  /help   Show this list',
  '  /runs   Browse past run directories',
  '  /evals  Run eval tasks',
  '  /exit   Quit Sherlock',
  'Keys',
  '  Esc     Cancel the current run',
  '  Ctrl+C  Quit',
].join('\n');

/**
 * Route one submitted composer line: `/`-prefixed lines are commands
 * (known or unknown), everything else is a task.
 */
export function routeInput(text: string): RoutedInput {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'task', text: trimmed };
  const command = trimmed.split(/\s+/, 1)[0]!;
  switch (command) {
    case '/help':
      return { kind: 'help' };
    case '/exit':
      return { kind: 'exit' };
    default:
      return { kind: 'unknown', command };
  }
}

/** The gentle notice an unknown command produces. */
export function unknownCommandNotice(command: string): string {
  return `Hmm, ${command} isn't a command I know — /help lists the available ones.`;
}

/** Fresh session state; the banner is the first transcript item. */
export function createInitialState(
  options: { apiKeyPresent?: boolean } = {},
): SessionState {
  return {
    mode: 'idle',
    transcript: [
      { id: 0, kind: 'banner', apiKeyPresent: options.apiKeyPresent ?? true },
    ],
    nextItemId: 1,
  };
}

/** Append one finalized item, assigning its stable id. */
function append(state: SessionState, item: TranscriptItemBody): SessionState {
  return {
    ...state,
    transcript: [...state.transcript, { ...item, id: state.nextItemId }],
    nextItemId: state.nextItemId + 1,
  };
}

/**
 * Fold one action into the session. Pure: same state + action, same
 * result. Bridge events beyond this step's scope pass through unchanged
 * (the live-region step extends this).
 */
export function reduce(state: SessionState, action: StoreAction): SessionState {
  switch (action.type) {
    case 'submit_task':
      return append(state, { kind: 'user_task', text: action.text });
    case 'notice':
      return append(state, { kind: 'notice', text: action.text });
    default:
      return state;
  }
}
