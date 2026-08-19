// Pure state management for the Sherlock session: slash-input routing and
// the reducer that folds actions/events into transcript items. No Ink
// imports — everything here is unit-testable with plain data.
//
// Finalization rules (the <Static> contract — items never re-render):
// - streaming agent text finalizes at the next tool batch or turn end;
// - a pending tool line finalizes when its execution result arrives — as
//   evidence iff that execution published artifacts (artifact_published
//   events precede its tool_exec_end), as plain activity otherwise;
// - pending lines that never receive exec events (registry-rejected calls
//   are invisible to the tracing seam) settle as ⚠ retried at the next
//   turn_start, or at run end.

import { formatDuration, formatTokens } from '../format.js';
import {
  filterCommands,
  findCommand,
  SLASH_COMMANDS,
  type CommandKind,
  type SlashCommand,
} from './commands.js';
import { deriveSemanticLine } from './semantic.js';
import type {
  ArtifactUiState,
  AssertionView,
  BannerIdentity,
  ComposerState,
  CompletionArtifact,
  LiveRunState,
  PublishedArtifact,
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
  | { type: 'composer_changed'; value: string }
  | { type: 'composer_submitted' }
  | { type: 'suggest_nav'; delta: -1 | 1 }
  | { type: 'suggest_dismiss' }
  | { type: 'tab_pressed' }
  | { type: 'cancel_requested' }
  | { type: 'open_runs' }
  | { type: 'close_overlay' }
  | { type: 'open_evals' }
  | { type: 'artifact_nav'; delta: -1 | 1 }
  | { type: 'artifact_open_detail' }
  | { type: 'artifact_close_detail' }
  | { type: 'artifacts_focus' }
  | { type: 'artifacts_blur' }
  | { type: 'evals_started'; tasks: string[]; k: number; concurrency: number }
  | {
      type: 'eval_trial_started';
      task: string;
      trial: number;
      k: number;
      headed: boolean;
    }
  | { type: 'eval_trial_progress'; task: string; trial: number; status: string }
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
  | { kind: 'artifacts' }
  | { kind: 'evals' }
  | { kind: 'exit' }
  | { kind: 'unknown'; command: string };

/** /help's name column: the longest command name plus two spaces. */
const HELP_NAME_PAD =
  Math.max(...SLASH_COMMANDS.map((entry) => entry.name.length)) + 2;

/** The /help transcript block: commands and keys (R10), driven by the
 * single SLASH_COMMANDS registry (R1). */
export const HELP_TEXT = [
  'Commands',
  ...SLASH_COMMANDS.map(
    (entry) => `  ${entry.name.padEnd(HELP_NAME_PAD)}${entry.description}`,
  ),
  'Keys',
  `  ${'Esc'.padEnd(HELP_NAME_PAD)}Cancel the current run`,
  `  ${'Ctrl+C'.padEnd(HELP_NAME_PAD)}Quit`,
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
    composer: initialComposer(),
    artifacts: [],
    artifactUi: initialArtifactUi(),
  };
}

/** The artifact rail/panel's rest state: first row, no detail open. */
function initialArtifactUi(): ArtifactUiState {
  return { cursor: 0, view: 'rows' };
}

/** The composer's rest state: empty line, first row, panel undismissed. */
function initialComposer(): ComposerState {
  return { value: '', dismissed: false, selectedIndex: 0, completions: 0 };
}

/** The composer's derived suggestion view — recomputed from state, never
 * stored (state.composer holds only what the user did). */
export interface SuggestionView {
  /** Commands the autosuggest panel offers (empty ⇒ panel hidden). */
  suggestions: readonly SlashCommand[];
  /** True while the panel renders — and while Tab means completion. */
  panelVisible: boolean;
  /** selectedIndex clamped into the match list, so a shrinking list can
   * never strand the selection (-1 with no matches, never rendered). */
  cursor: number;
  /** The highlighted command, when the panel is up. */
  selected: SlashCommand | undefined;
}

/**
 * Derive the suggestion panel from the composer substate. The composer
 * accepts input only while idle (App mounts it disabled in every other
 * mode), so suggestions exist only there; Esc-dismissal holds until the
 * input next changes.
 */
export function deriveSuggestions(state: SessionState): SuggestionView {
  const suggestions =
    state.mode === 'idle' && !state.composer.dismissed
      ? filterCommands(state.composer.value)
      : [];
  const panelVisible = suggestions.length > 0;
  const cursor = Math.min(state.composer.selectedIndex, suggestions.length - 1);
  return {
    suggestions,
    panelVisible,
    cursor,
    selected: panelVisible ? suggestions[cursor] : undefined,
  };
}

/** Clamp an artifact cursor into the list's current bounds. */
function clampCursor(cursor: number, length: number): number {
  return Math.max(0, Math.min(cursor, length - 1));
}

/**
 * Shared helper proposals are review candidates rather than ordinary
 * deliverables. Even when a task explicitly requests one, the verified-run
 * UI keeps it in its own final group so it cannot be mistaken for a normal
 * requested output.
 */
export function isHelperProposalArtifact(artifact: PublishedArtifact): boolean {
  return artifact.entry.filename.startsWith('artifacts/helper-proposals/');
}

/**
 * Summary display order: requested outputs first, then evidence-only
 * artifacts, then verified helper proposals; each group keeps publish order.
 * The live rail keeps raw publish order (chronological log); the completion
 * panel and transcript digest use this instead.
 */
export function orderArtifactsForSummary(
  artifacts: readonly PublishedArtifact[],
): readonly PublishedArtifact[] {
  const isRequested = (artifact: PublishedArtifact) =>
    (artifact.entry.roles ?? []).includes('requested_output');
  return [
    ...artifacts.filter(
      (artifact) => isRequested(artifact) && !isHelperProposalArtifact(artifact),
    ),
    ...artifacts.filter(
      (artifact) => !isRequested(artifact) && !isHelperProposalArtifact(artifact),
    ),
    ...artifacts.filter(isHelperProposalArtifact),
  ];
}

/** The completion item's inert artifact digest, in summary order. */
function completionDigest(
  artifacts: readonly PublishedArtifact[],
): readonly CompletionArtifact[] {
  return orderArtifactsForSummary(artifacts).map((artifact) => ({
    filename: artifact.entry.filename,
    sizeBytes: artifact.sizeBytes,
    roles: artifact.entry.roles ?? [],
  }));
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

/** Finish calls are coordinator control flow, not registry tools,
 * so the tracing seam has no tool_exec_end with which to settle them. Resolve
 * the terminal control line from the run outcome before generic dangling
 * calls become retried warnings. */
function settleTerminalControlPending(
  state: SessionState,
  status: 'ok' | 'error',
): SessionState {
  const live = state.live;
  if (live === undefined) return state;
  const controls = live.pendingTools.filter(
    (pending) => pending.name === 'finish',
  );
  if (controls.length === 0) return state;
  let next = state;
  for (const pending of controls) {
    const line =
      pending.line === pending.name
        ? deriveSemanticLine(pending.name).line
        : pending.line;
    next = append(next, { kind: 'activity', line, status });
  }
  return {
    ...next,
    live: {
      ...live,
      pendingTools: live.pendingTools.filter((pending) => !controls.includes(pending)),
    },
  };
}

/** Tokens the run has visibly consumed right now (estimate ≥ settled). */
function displayTokens(live: LiveRunState): number {
  return Math.round(Math.max(live.tokens.settled, live.tokens.estimate));
}

/** End the run: clear the live region — retaining its run dir so
 * /artifacts can open files after runs that record no completion summary
 * (cancelled/failed carry no runDir of their own) — and return to idle,
 * or to evalsRunning while an eval batch owns the session. */
function endRun(state: SessionState): SessionState {
  const { live, ...rest } = state;
  return {
    ...rest,
    ...(live?.runDir === undefined ? {} : { lastRunDir: live.runDir }),
    mode: state.evalsActive === true ? 'evalsRunning' : 'idle',
  };
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

    case 'composer_changed':
      // Every edit re-arms the panel (dismissal ends at the next change)
      // and returns the selection to the top of the fresh match list.
      return {
        ...state,
        composer: {
          ...state.composer,
          value: action.value,
          selectedIndex: 0,
          dismissed: false,
        },
      };

    case 'composer_submitted':
      // App dispatches this alongside routing the submitted text: the
      // field clears for the next line. Idempotent — completions stays,
      // since the controlled TextInput clamps its cursor on shrink.
      return {
        ...state,
        composer: { ...state.composer, value: '', selectedIndex: 0, dismissed: false },
      };

    case 'suggest_nav': {
      // ↑/↓ while the panel is up; clamped at both ends, from the
      // derived (already-clamped) cursor.
      const { panelVisible, cursor, suggestions } = deriveSuggestions(state);
      if (!panelVisible) return state;
      const selectedIndex = Math.max(
        0,
        Math.min(suggestions.length - 1, cursor + action.delta),
      );
      return { ...state, composer: { ...state.composer, selectedIndex } };
    }

    case 'suggest_dismiss':
      // Esc while the panel is up hides it until the input next changes.
      if (!deriveSuggestions(state).panelVisible) return state;
      return { ...state, composer: { ...state.composer, dismissed: true } };

    case 'tab_pressed': {
      // App's single Tab route; the reducer arbitrates what Tab means
      // against the same state it mutates. Precedence: suggestion
      // completion beats the artifacts panel (a visible panel implies
      // idle mode, so the branches below cannot also apply).
      const { panelVisible, cursor, suggestions } = deriveSuggestions(state);
      if (panelVisible) {
        // Complete to "<name> " — the trailing space readies the line
        // for arguments and, containing whitespace, hides the panel.
        // Not a submission; completions keys the TextInput remount that
        // puts the cursor after the grown value.
        const selected = suggestions[cursor]!;
        return {
          ...state,
          composer: {
            ...state.composer,
            value: `${selected.name} `,
            selectedIndex: 0,
            completions: state.composer.completions + 1,
          },
        };
      }
      // Toggle focus on the completion artifacts panel (design decision
      // 4), reusing the guarded focus/blur cases verbatim.
      if (state.mode === 'artifacts') return reduce(state, { type: 'artifacts_blur' });
      if (state.mode === 'idle' && state.completedRun !== undefined) {
        return reduce(state, { type: 'artifacts_focus' });
      }
      return state;
    }

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

    case 'artifact_nav': {
      // Clamped at both ends; meaningless without rows to move over.
      if (state.artifacts.length === 0) return state;
      const cursor = clampCursor(
        state.artifactUi.cursor + action.delta,
        state.artifacts.length,
      );
      return { ...state, artifactUi: { ...state.artifactUi, cursor } };
    }

    case 'artifact_open_detail':
      if (state.artifacts.length === 0) return state;
      return { ...state, artifactUi: { ...state.artifactUi, view: 'detail' } };

    case 'artifact_close_detail':
      // Esc with a detail card open lands here (App checks the view
      // before treating Esc as cancel); it never touches the run mode.
      if (state.artifactUi.view === 'rows') return state;
      return { ...state, artifactUi: { ...state.artifactUi, view: 'rows' } };

    case 'artifacts_focus':
      // Tab on the idle completion panel (or /artifacts) hands the keys
      // to the artifact rows; meaningless without rows to browse. A fresh
      // focus always starts at the top with no stale detail card.
      if (state.mode !== 'idle' || state.artifacts.length === 0) return state;
      return { ...state, mode: 'artifacts', artifactUi: initialArtifactUi() };

    case 'artifacts_blur':
      // Tab again (or Esc from the rows view) returns the keys to the
      // composer; the panel stays visible, passive.
      if (state.mode !== 'artifacts') return state;
      return { ...state, mode: 'idle' };

    case 'evals_started':
      return {
        ...append(state, {
          kind: 'notice',
          text:
            `Running evals: ${action.tasks.join(', ')} · k=${action.k} · ` +
            `concurrency=${action.concurrency}`,
        }),
        mode: 'evalsRunning',
        evalsActive: true,
        evalsLive: {},
      };

    case 'eval_trial_started': {
      const key = evalTrialKey(action.task, action.trial);
      return {
        ...state,
        evalsLive: {
          ...state.evalsLive,
          [key]: {
            task: action.task,
            trial: action.trial,
            k: action.k,
            headed: action.headed,
            status: 'starting',
          },
        },
      };
    }

    case 'eval_trial_progress': {
      const key = evalTrialKey(action.task, action.trial);
      const current = state.evalsLive?.[key];
      if (current === undefined) return state;
      return {
        ...state,
        evalsLive: {
          ...state.evalsLive,
          [key]: { ...current, status: action.status },
        },
      };
    }

    case 'eval_trial_done': {
      const key = evalTrialKey(action.task, action.trial);
      const { [key]: _finished, ...remaining } = state.evalsLive ?? {};
      const next = append(state, {
        kind: 'eval_trial',
        task: action.task,
        trial: action.trial,
        k: action.k,
        assertions: action.assertions,
        elapsedMs: action.elapsedMs,
      });
      return { ...next, evalsLive: remaining };
    }

    case 'eval_report_ready':
      return append(state, { kind: 'eval_report', text: action.text });

    case 'eval_error':
      return append(state, { kind: 'error', message: action.message });

    case 'evals_finished': {
      const { evalsActive: _evalsActive, evalsLive: _evalsLive, ...rest } = state;
      return { ...rest, mode: 'idle' };
    }

    case 'run_started': {
      // The previous run's completion summary is superseded, not kept.
      const { completedRun: _completedRun, ...rest } = state;
      return {
        ...rest,
        mode: 'running',
        artifacts: [],
        artifactUi: initialArtifactUi(),
        live: {
          streamingText: '',
          pendingTools: [],
          nextPendingId: 1,
          startedAt: action.at,
          tokens: { settled: 0, estimate: 0 },
          turn: 0,
        },
      };
    }

    case 'run_dir':
      if (state.live === undefined) return state;
      return { ...state, live: { ...state.live, runDir: action.runDir } };

    case 'browser_session': {
      // Local Chrome is already a window on the user's own screen — a
      // transcript line announcing it would just be noise about something
      // they can already see.
      if (action.provider === 'local') return state;
      const id = action.sessionId ?? '(unknown)';
      const text =
        action.liveViewUrl === undefined
          ? `Browserbase session ${id} (no Live View URL available)`
          : `Browserbase session ${id} — watch or take over: ${action.liveViewUrl}`;
      return append(state, { kind: 'notice', text });
    }

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
      // Publish-driven classification: an execution reads as evidence iff
      // it actually published (a scratch write publishes nothing however
      // evidence-flavored its name). Failures stay error activity.
      const published = finished.published ?? [];
      const sourceUrl = published.find((entry) => entry.sourceUrl !== undefined)?.sourceUrl;
      const withItem = action.ok && published.length > 0
        ? append(state, {
            kind: 'evidence',
            line: finished.line,
            ...(sourceUrl !== undefined ? { sourceUrl } : {}),
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

    case 'permission_request':
      // The question dialog is App-local state (it holds a resolve
      // function, which this pure store must not). The event settles any
      // streaming prose so the transcript is stable while the run pauses.
      if (state.live === undefined) return state;
      return finalizeStreamingText(state);

    case 'artifact_published': {
      const live = state.live;
      if (live === undefined) return state;
      const record = { entry: action.entry, sizeBytes: action.sizeBytes };
      const known = state.artifacts.some(
        (artifact) => artifact.entry.filename === action.entry.filename,
      );
      const artifacts = known
        ? state.artifacts.map((artifact) =>
            artifact.entry.filename === action.entry.filename ? record : artifact,
          )
        : [...state.artifacts, record];
      // Tag the publishing execution so its tool_exec_end finalizes as an
      // evidence line carrying the entry's sourceUrl.
      const pendingTools = live.pendingTools.map((pending) =>
        pending.execId === action.toolExecId
          ? { ...pending, published: [...(pending.published ?? []), action.entry] }
          : pending,
      );
      // Keep the rail cursor in bounds as the list changes underneath it.
      const artifactUi = {
        ...state.artifactUi,
        cursor: clampCursor(state.artifactUi.cursor, artifacts.length),
      };
      return { ...state, artifacts, artifactUi, live: { ...live, pendingTools } };
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
      const successful = action.outcome === 'completed' || action.outcome === 'verified';
      const humanFacing = successful || action.outcome === 'incomplete';
      let next = settleTerminalControlPending(
        finalizeStreamingText(state),
        humanFacing ? 'ok' : 'error',
      );
      next = settleDanglingPending(next);
      const elapsedMs = action.at - live.startedAt;
      const tokens = displayTokens(next.live!);
      if (humanFacing) {
        const outcome = successful ? 'complete' : 'incomplete';
        next = append(next, {
          kind: 'completion',
          outcome,
          verb: state.completionVerb,
          elapsedMs,
          tokens,
          runDir: action.runDir,
          artifacts: completionDigest(state.artifacts),
        });
        // Record the completion panel's summary — interactive runs only
        // (eval trials complete between trials, where no panel belongs).
        if (state.evalsActive !== true) {
          next = {
            ...next,
            completedRun: {
              outcome,
              unresolved: action.unresolved ?? [],
              verb: state.completionVerb,
              elapsedMs,
              tokens,
              runDir: action.runDir,
              ...(action.finalText === undefined ? {} : { finalText: action.finalText }),
            },
          };
        }
      } else {
        // Synthetic legacy budget stops retain their historical diagnostic
        // rendering. Real incomplete runs take the human-facing branch above.
        const reason =
          action.reason === 'max_turns'
            ? 'turn limit reached'
            : 'context budget exhausted';
        next = append(next, {
          kind: 'error',
          message:
            `Stopped early after ${formatDuration(elapsedMs)} · ` +
            `${formatTokens(tokens)} — ${reason}` +
            (action.detail === undefined ? '' : `\n  ${action.detail}`) +
            `\n  ${action.runDir}`,
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

function evalTrialKey(task: string, trial: number): string {
  return `${task}\u0000${trial}`;
}
