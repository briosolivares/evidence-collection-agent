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
import { findCommand, SLASH_COMMANDS, type CommandKind } from './commands.js';
import { deriveSemanticLine } from './semantic.js';
import type {
  AssertionView,
  BannerIdentity,
  LiveRunState,
  SessionState,
  TranscriptItemBody,
  UiEvent,
} from './state.js';

const VERBOSE_MAX = 400;

/** Compact any value into a one-line verbose detail string. */
function compactDetail(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
  } catch {
    text = String(value);
  }
  return text.length > VERBOSE_MAX ? `${text.slice(0, VERBOSE_MAX - 1)}…` : text;
}

/** UI-originated actions (composer submits, slash-command output, Esc,
 * overlay control). */
export type UiAction =
  | { type: 'submit_task'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'cancel_requested' }
  | { type: 'open_runs' }
  | { type: 'close_overlay' }
  | { type: 'open_evals' }
  | { type: 'evals_started'; tasks: string[]; k: number }
  | { type: 'eval_trial_started'; task: string; trial: number; k: number }
  | {
      type: 'eval_trial_done';
      task: string;
      trial: number;
      k: number;
      assertions: AssertionView[];
      elapsedMs: number;
    }
  | { type: 'eval_report_ready'; text: string }
  | { type: 'eval_error'; message: string }
  | { type: 'evals_finished' };

/** Everything the reducer consumes. */
export type StoreAction = UiAction | UiEvent;

/** Where a submitted line should go, decided purely from its text. */
export type RoutedInput =
  | { kind: 'task'; text: string }
  | { kind: 'help' }
  | { kind: 'runs' }
  | { kind: 'evals' }
  | { kind: 'exit' }
  | { kind: 'unknown'; command: string };

/** The /help transcript block: commands and keys (R10), driven by the
 * single SLASH_COMMANDS registry (R1). */
export const HELP_TEXT = [
  'Commands',
  ...SLASH_COMMANDS.map((entry) => `  ${entry.name.padEnd(8)}${entry.description}`),
  'Keys',
  '  Esc     Cancel the current run',
  '  Ctrl+C  Quit',
].join('\n');

/**
 * Route one submitted composer line: `/`-prefixed lines are commands
 * (known — per the SLASH_COMMANDS registry — or unknown), everything
 * else is a task.
 */
export function routeInput(text: string): RoutedInput {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'task', text: trimmed };
  const command = trimmed.split(/\s+/, 1)[0]!;
  const known = findCommand(command);
  if (known === undefined) return { kind: 'unknown', command };
  // Registry names are `/${kind}` by construction, so the slice is safe.
  return { kind: known.name.slice(1) as CommandKind };
}

/** The gentle notice an unknown command produces. */
export function unknownCommandNotice(command: string): string {
  return `Hmm, ${command} isn't a command I know — /help lists the available ones.`;
}

/** Fresh session state; the banner (welcome card) is the first transcript
 * item. `identity` arrives precomputed — the reducer never touches
 * process/git itself. */
export function createInitialState(
  options: {
    apiKeyPresent?: boolean;
    completionVerb?: string;
    identity?: BannerIdentity | undefined;
  } = {},
): SessionState {
  return {
    mode: 'idle',
    transcript: [
      {
        id: 0,
        kind: 'banner',
        apiKeyPresent: options.apiKeyPresent ?? true,
        ...(options.identity === undefined ? {} : { identity: options.identity }),
      },
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

/** End the run: clear the live region; an active eval batch returns to
 * evalsRunning (between trials), everything else to idle. */
function endRun(state: SessionState): SessionState {
  const { live: _live, ...rest } = state;
  return { ...rest, mode: state.evalsActive === true ? 'evalsRunning' : 'idle' };
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

    case 'cancel_requested':
      // Esc is meaningful only while a run streams; a second press while
      // already cancelling (or any press while idle) is a no-op.
      if (state.mode !== 'running') return state;
      return { ...state, mode: 'cancelling' };

    case 'open_runs':
      if (state.mode !== 'idle') return state;
      return { ...state, mode: 'runsList' };

    case 'close_overlay':
      if (state.mode !== 'runsList' && state.mode !== 'evalsMenu') return state;
      return { ...state, mode: 'idle' };

    case 'open_evals':
      if (state.mode !== 'idle') return state;
      return { ...state, mode: 'evalsMenu' };

    case 'evals_started':
      return {
        ...append(state, {
          kind: 'notice',
          text: `Running evals: ${action.tasks.join(', ')} · k=${action.k}`,
        }),
        mode: 'evalsRunning',
        evalsActive: true,
      };

    case 'eval_trial_started':
      return append(state, {
        kind: 'notice',
        text: `— ${action.task} · trial ${action.trial}/${action.k} —`,
      });

    case 'eval_trial_done':
      return append(state, {
        kind: 'eval_trial',
        task: action.task,
        trial: action.trial,
        k: action.k,
        assertions: action.assertions,
        elapsedMs: action.elapsedMs,
      });

    case 'eval_report_ready':
      return append(state, { kind: 'eval_report', text: action.text });

    case 'eval_error':
      return append(state, { kind: 'error', message: action.message });

    case 'evals_finished': {
      const { evalsActive: _evalsActive, ...rest } = state;
      return { ...rest, mode: 'idle' };
    }

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
      const semantic = deriveSemanticLine(action.name, action.input);
      const upgraded = {
        name: action.name,
        execId: action.id,
        line: semantic.line,
        isEvidence: semantic.isEvidence,
        verbose: { input: compactDetail(action.input), result: '' },
      };
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
              { id: live.nextPendingId, ...upgraded },
            ],
          },
        };
      }
      // The stream announced this tool by name; upgrade its line in place.
      return {
        ...next,
        live: {
          ...live,
          pendingTools: live.pendingTools.map((pending) =>
            pending === waiting ? { ...pending, ...upgraded } : pending,
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
      const verbose =
        finished.verbose === undefined
          ? undefined
          : {
              input: finished.verbose.input,
              result: action.ok
                ? compactDetail(action.result)
                : compactDetail(action.error ?? 'error'),
            };
      const withItem = finished.isEvidence && action.ok
        ? append(state, {
            kind: 'evidence',
            line: finished.line,
            ...(action.sourceUrl !== undefined ? { sourceUrl: action.sourceUrl } : {}),
            ...(verbose !== undefined ? { verbose } : {}),
          })
        : append(state, {
            kind: 'activity',
            line: finished.line,
            status: action.ok ? 'ok' : 'error',
            ...(verbose !== undefined ? { verbose } : {}),
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
