// Pure state management for the Sherlock session: slash-input routing and
// the reducer that folds actions/events into transcript items. No Ink
// imports — everything here is unit-testable with plain data.
//
// Finalization rules (the <Static> contract — items never re-render):
// - streaming agent text finalizes at the next tool batch or turn end;
// - a pending tool line finalizes when its execution result arrives;
// - pending lines that never receive exec events (registry-rejected calls
//   are invisible to the tracing seam) settle as ⚠ retried at the next
//   turn_start, or at run end.

import { formatDuration, formatTokens } from '../format.js';
import type {
  LiveRunState,
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
  options: { apiKeyPresent?: boolean; completionVerb?: string } = {},
): SessionState {
  return {
    mode: 'idle',
    transcript: [
      { id: 0, kind: 'banner', apiKeyPresent: options.apiKeyPresent ?? true },
    ],
    nextItemId: 1,
    completionVerb: options.completionVerb ?? 'Brewed',
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

/** Finalize any streaming prose into an agent_text item. */
function finalizeStreamingText(state: SessionState): SessionState {
  const live = state.live;
  if (live === undefined || live.streamingText === '') return state;
  const appended = append(state, { kind: 'agent_text', text: live.streamingText });
  return { ...appended, live: { ...live, streamingText: '' } };
}

/** Settle every still-pending tool line as ⚠ retried. */
function settleDanglingPending(state: SessionState): SessionState {
  const live = state.live;
  if (live === undefined || live.pendingTools.length === 0) return state;
  let next = state;
  for (const pending of live.pendingTools) {
    next = append(next, { kind: 'activity', line: pending.line, status: 'retried' });
  }
  return { ...next, live: { ...live, pendingTools: [] } };
}

/** Tokens the run has visibly consumed right now (estimate ≥ settled). */
function displayTokens(live: LiveRunState): number {
  return Math.round(Math.max(live.tokens.settled, live.tokens.estimate));
}

/** End the run: clear the live region and return to idle. */
function endRun(state: SessionState): SessionState {
  const { live: _live, ...rest } = state;
  return { ...rest, mode: 'idle' };
}

/**
 * Fold one action into the session. Pure: same state + action, same
 * result. Run events are ignored while no run is live (a stale event
 * after cancellation must not corrupt the next run).
 */
export function reduce(state: SessionState, action: StoreAction): SessionState {
  switch (action.type) {
    case 'submit_task':
      return append(state, { kind: 'user_task', text: action.text });

    case 'notice':
      return append(state, { kind: 'notice', text: action.text });

    case 'run_started':
      return {
        ...state,
        mode: 'running',
        live: {
          streamingText: '',
          pendingTools: [],
          nextPendingId: 1,
          startedAt: action.at,
          tokens: { settled: 0, estimate: 0 },
          turn: 0,
        },
      };

    case 'run_dir':
      if (state.live === undefined) return state;
      return { ...state, live: { ...state.live, runDir: action.runDir } };

    case 'turn_start': {
      if (state.live === undefined) return state;
      const next = settleDanglingPending(finalizeStreamingText(state));
      return { ...next, live: { ...next.live!, turn: action.turn } };
    }

    case 'text_delta': {
      const live = state.live;
      if (live === undefined) return state;
      return {
        ...state,
        live: {
          ...live,
          streamingText: live.streamingText + action.text,
          tokens: {
            ...live.tokens,
            estimate: live.tokens.estimate + action.text.length / 4,
          },
        },
      };
    }

    case 'tool_pending': {
      if (state.live === undefined) return state;
      const next = finalizeStreamingText(state);
      const live = next.live!;
      return {
        ...next,
        live: {
          ...live,
          nextPendingId: live.nextPendingId + 1,
          pendingTools: [
            ...live.pendingTools,
            {
              id: live.nextPendingId,
              name: action.name,
              line: action.name,
              isEvidence: false,
            },
          ],
        },
      };
    }

    case 'tool_exec_start': {
      if (state.live === undefined) return state;
      const next = finalizeStreamingText(state);
      const live = next.live!;
      const waiting = live.pendingTools.find(
        (pending) => pending.execId === undefined && pending.name === action.name,
      );
      if (waiting === undefined) {
        return {
          ...next,
          live: {
            ...live,
            nextPendingId: live.nextPendingId + 1,
            pendingTools: [
              ...live.pendingTools,
              {
                id: live.nextPendingId,
                name: action.name,
                execId: action.id,
                line: action.name,
                isEvidence: false,
              },
            ],
          },
        };
      }
      return {
        ...next,
        live: {
          ...live,
          pendingTools: live.pendingTools.map((pending) =>
            pending === waiting ? { ...pending, execId: action.id } : pending,
          ),
        },
      };
    }

    case 'tool_exec_end': {
      const live = state.live;
      if (live === undefined) return state;
      const finished = live.pendingTools.find(
        (pending) => pending.execId === action.id,
      );
      if (finished === undefined) return state;
      const remaining = live.pendingTools.filter((pending) => pending !== finished);
      const withItem = finished.isEvidence && action.ok
        ? append(state, {
            kind: 'evidence',
            line: finished.line,
            ...(finished.sourceUrl !== undefined ? { sourceUrl: finished.sourceUrl } : {}),
            ...(finished.verbose !== undefined ? { verbose: finished.verbose } : {}),
          })
        : append(state, {
            kind: 'activity',
            line: finished.line,
            status: action.ok ? 'ok' : 'error',
            ...(finished.verbose !== undefined ? { verbose: finished.verbose } : {}),
          });
      return { ...withItem, live: { ...live, pendingTools: remaining } };
    }

    case 'turn_end': {
      const next = finalizeStreamingText(state);
      const live = next.live;
      if (live === undefined) return next;
      const settled =
        live.tokens.settled + action.usage.input + action.usage.output;
      return {
        ...next,
        live: { ...live, tokens: { settled, estimate: settled } },
      };
    }

    case 'run_finished': {
      const live = state.live;
      if (live === undefined) return state;
      let next = settleDanglingPending(finalizeStreamingText(state));
      const elapsedMs = action.at - live.startedAt;
      const tokens = displayTokens(next.live!);
      if (action.outcome === 'completed') {
        next = append(next, {
          kind: 'completion',
          verb: state.completionVerb,
          elapsedMs,
          tokens,
          runDir: action.runDir,
        });
      } else {
        const reason =
          action.reason === 'max_turns'
            ? 'turn limit reached'
            : 'token budget exhausted';
        next = append(next, {
          kind: 'error',
          message:
            `Stopped early after ${formatDuration(elapsedMs)} · ` +
            `${formatTokens(tokens)} — ${reason}\n  ${action.runDir}`,
        });
      }
      return endRun(next);
    }

    case 'run_cancelled': {
      const live = state.live;
      if (live === undefined) return state;
      let next = settleDanglingPending(finalizeStreamingText(state));
      next = append(next, {
        kind: 'cancelled',
        elapsedMs: action.at - live.startedAt,
        tokens: displayTokens(next.live!),
      });
      return endRun(next);
    }

    case 'run_failed': {
      if (state.live === undefined) {
        return endRun(append(state, { kind: 'error', message: action.message }));
      }
      let next = settleDanglingPending(finalizeStreamingText(state));
      next = append(next, { kind: 'error', message: action.message });
      return endRun(next);
    }
  }
}
