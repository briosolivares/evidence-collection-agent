// The session store's data model (design "Data Models"): finalized
// transcript items (append-only — they drive Ink's <Static>, which never
// re-renders an item), the live run state that stays mutable until
// finalized, and the single UiEvent stream the reducer consumes.

import type { ArtifactRole, ManifestEntry } from '../../run/artifacts.js';
import type { BrowserProviderKind } from '../../browser/sessionProvider.js';
import type { UnresolvedRequirement } from '../../run/runOutcome.js';

/** Interaction modes; overlays are modes so exactly one surface owns input. */
export type SessionMode =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'artifacts'
  | 'runsList'
  | 'evalsMenu'
  | 'evalsRunning';

/**
 * Who and where the startup welcome card greets. Computed at the edge
 * (main.tsx: git config / os / DEFAULT_MODEL) and injected — never inside
 * the reducer, which stays pure. Absent → the card renders its generic
 * fallback (no name, no footer), keeping bare test renders deterministic.
 */
export interface BannerIdentity {
  /** First name for the `Welcome back {name}!` line. */
  name: string;
  /** Model id shown in the card footer. */
  model: string;
  /** Working directory (home shortened to `~`) shown in the footer. */
  cwd: string;
}

/** One artifact row of the /runs detail view (from manifest.json). */
export interface ManifestArtifactView {
  filename: string;
  sizeBytes: number | undefined;
  sha256Prefix: string;
}

/** What the /runs detail view shows from a run's manifest. */
export interface ManifestView {
  task: string;
  startedAt: string;
  finishedAt?: string;
  artifacts: ManifestArtifactView[];
}

/** What the /runs detail view shows from a run's metrics, when present. */
export interface MetricsView {
  status: string;
  turns: number;
  totalTokens: number;
  wallClockMs: number;
}

/** One per-trial assertion verdict in an eval transcript block. */
export interface AssertionView {
  name: string;
  passed: boolean;
  detail?: string;
}

/** One keyed row in the concurrent eval live region. */
export interface EvalTrialLive {
  task: string;
  trial: number;
  k: number;
  headed: boolean;
  status: string;
}

/**
 * One artifact digest line of a completion item — filename · size ·
 * role(s), the transcript's permanent, inert copy of the completion
 * summary after the panel is superseded.
 */
export interface CompletionArtifact {
  /** Run-dir-relative path, as the manifest records it. */
  filename: string;
  /** Size on disk at publish time; undefined if the stat failed. */
  sizeBytes: number | undefined;
  /** The published entry's roles (requested_output and/or evidence). */
  roles: readonly ArtifactRole[];
}

/**
 * A finalized transcript entry, before its id is assigned. Items are
 * append-only and immutable once appended (the <Static> contract);
 * anything still changing lives in LiveRunState instead.
 */
export type TranscriptItemBody =
  | { kind: 'banner'; apiKeyPresent: boolean; identity?: BannerIdentity }
  | { kind: 'user_task'; text: string }
  | { kind: 'agent_text'; text: string }
  | {
      kind: 'activity';
      line: string;
      status: 'ok' | 'error' | 'retried';
      verbose?: { input: string; result: string };
    }
  | {
      kind: 'evidence';
      line: string;
      sourceUrl?: string;
      verbose?: { input: string; result: string };
    }
  | {
      kind: 'completion';
      outcome: 'complete' | 'incomplete';
      elapsedMs: number;
      tokens: number;
      runDir: string;
      /** Published-artifact digest, requested outputs first (the same
       * order the summary panel shows). */
      artifacts: readonly CompletionArtifact[];
    }
  | { kind: 'cancelled'; elapsedMs: number; tokens: number }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; text: string }
  | {
      kind: 'eval_trial';
      task: string;
      trial: number;
      k: number;
      assertions: AssertionView[];
      elapsedMs: number;
    }
  | { kind: 'eval_report'; text: string };

/** A finalized transcript entry; `id` is the stable render key. */
export type TranscriptItem = TranscriptItemBody & { id: number };

/** A tool line still awaiting its result — rendered in the live region. */
export interface PendingTool {
  /** Local key, unique within the run. */
  id: number;
  /** Tool name, used to pair stream-announced lines with exec events. */
  name: string;
  /** Execution id from the tracing seam, once execution has started. */
  execId?: number;
  line: string;
  /** Likely-evidence hint styling the in-flight line; the finalized item's
   * activity/evidence classification is decided by publishes instead. */
  isEvidence: boolean;
  /** Manifest entries this execution has published so far (each
   * artifact_published event precedes its execution's tool_exec_end). */
  published?: readonly ManifestEntry[];
  verbose?: { input: string; result: string };
}

/**
 * One published artifact of the current (or most recent) run. The manifest
 * entry is kept verbatim — filename, roles, sourceUrl, full sha256,
 * capturedAt — so later surfaces (artifact rail, /artifacts, completion
 * summary) can render full provenance and order requested outputs first
 * without re-reading manifest.json.
 */
export interface PublishedArtifact {
  entry: ManifestEntry;
  /** Size on disk at publish time; undefined if the stat failed. */
  sizeBytes: number | undefined;
}

/**
 * What the terminal summary panel shows for the run that just finished:
 * status, final answer prose, unresolved requirements, and deterministic
 * timing/location data. Recorded for verified and incomplete interactive
 * runs (eval trials, cancellation, and runtime failures never set it) and
 * cleared by the next run_started.
 */
export interface CompletedRunSummary {
  /** Worker completion-report prose. Synthetic complete events may omit it;
   * incomplete events then use the deterministic no-report fallback. */
  finalText?: string;
  /** Whether the judge accepted the work. Synthetic demo completions use
   * complete; real runs use complete only for verified outcomes. */
  outcome: 'complete' | 'incomplete';
  /** Worker-reported blockers shown concisely for incomplete runs. */
  unresolved: readonly UnresolvedRequirement[];
  /** Wall-clock duration of the run. */
  elapsedMs: number;
  /** Tokens the run visibly consumed (settled or estimate, whichever is
   * larger — the same figure the completion line shows). */
  tokens: number;
  /** Absolute run directory; artifact rows open files against it. */
  runDir: string;
}

/**
 * Selection state of the artifact surfaces (the live rail now; the
 * completion panel later). Owned by the reducer — a deliberate deviation
 * from RunsList's component-local view state: while running, Esc belongs
 * to App's global handler (cancel), and closing an open detail card must
 * win over cancelling the run, so the handler needs this state to consult
 * before treating Esc as cancel (design decision 3). Bonus: the whole
 * interaction is reducer-testable without Ink.
 */
export interface ArtifactUiState {
  /** Index of the highlighted row in `artifacts`, clamped as the list
   * changes (upserts arrive mid-run). */
  cursor: number;
  /** 'rows' lists the artifacts; 'detail' shows the highlighted one's
   * provenance card. */
  view: 'rows' | 'detail';
}

/**
 * The composer's input substate. Reducer-owned, not component-local, by
 * the same rule that promoted ArtifactUiState (design decision 3):
 * a globally-routed key's meaning depends on it — Tab completes the
 * highlighted suggestion while the panel is up and only otherwise
 * focuses/blurs the artifacts panel — so App's single 'tab_pressed'
 * route must decide against the same state it mutates, never a
 * one-frame-stale mirror. Suggestions and panel visibility are pure
 * derivations of this substate plus the mode (deriveSuggestions in the
 * reducer module); they are never stored.
 */
export interface ComposerState {
  /** The input line as typed. */
  value: string;
  /** True after Esc dismissed the panel, until the input next changes. */
  dismissed: boolean;
  /** Selected suggestion row; clamped against the derived match list
   * wherever it is read, so a shrinking list never strands it. */
  selectedIndex: number;
  /** Bumped on every Tab completion. TextInput only derives its internal
   * cursor offset on mount (afterwards it merely clamps to a shrinking
   * value), so an externally grown value would leave the cursor
   * mid-word; keying the input on this count remounts it with the
   * cursor at the end. */
  completions: number;
}

/** The dynamic region's state — mutable until finalized into items. */
export interface LiveRunState {
  /** Model prose still streaming (finalizes at tool batches / turn end). */
  streamingText: string;
  /** Tool lines awaiting results. */
  pendingTools: PendingTool[];
  /** Local id source for pending tool lines. */
  nextPendingId: number;
  /** Epoch ms the run started (drives elapsed time). */
  startedAt: number;
  /** Settled = summed turn_end usage (input + output); estimate = settled
   * plus a light in-turn guess from streamed text (~chars/4), snapped back
   * to settled at each turn_end. */
  tokens: { settled: number; estimate: number };
  /** Known once tracing captures it (step 6); shown on completion. */
  runDir?: string;
}

/**
 * The bridge's event stream, plus UI-originated actions — the single
 * union the reducer consumes. Events that end or start a timed run carry
 * an `at` epoch-ms stamp (added by the dispatcher) so the reducer stays
 * pure while computing elapsed durations.
 */
export type UiEvent =
  | { type: 'run_started'; task: string; at: number }
  | { type: 'run_dir'; runDir: string }
  | {
      /** A browser session now backs the run — emitted once, right after
       * ensureBrowser() creates it (fresh launch or post-death relaunch).
       * Local Chrome carries no diagnostics and never reaches here; only a
       * remote provider (Browserbase) has anything worth telling a human
       * about. Never carries the CDP connection URL — see
       * BrowserSessionDiagnostics for why that invariant matters. */
      type: 'browser_session';
      provider: BrowserProviderKind;
      sessionId?: string;
      liveViewUrl?: string;
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_pending'; name: string }
  | { type: 'tool_exec_start'; id: number; name: string; input: unknown }
  | { type: 'tool_exec_end'; id: number; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'artifact_published';
      /** The manifest's provenance record, verbatim (published entries
       * only — scratch entries are never emitted). */
      entry: ManifestEntry;
      /** Size on disk at publish time; undefined if the stat failed. */
      sizeBytes: number | undefined;
      /** The execution that published it, emitted before that execution's
       * tool_exec_end so the reducer holds provenance when it renders. */
      toolExecId: number;
    }
  | {
      /** An interactive tool is paused awaiting the user (announcement
       * only — the resolution travels through the requestPermission
       * promise, not the event stream). */
      type: 'permission_request';
      toolName: string;
      input: unknown;
    }
  | { type: 'turn_end'; usage: { input: number; output: number } }
  | {
      type: 'run_finished';
      outcome: 'verified' | 'incomplete';
      finalText?: string;
      /** Worker-reported unresolved request parts for an incomplete run. */
      unresolved?: readonly UnresolvedRequirement[];
      runDir: string;
      at: number;
    }
  | { type: 'run_cancelled'; at: number }
  | { type: 'run_failed'; message: string; at: number };

/** The whole session: mode machine + transcript + live region. */
export interface SessionState {
  mode: SessionMode;
  transcript: readonly TranscriptItem[];
  /** Monotonic id source for transcript items. */
  nextItemId: number;
  /** Whether checkout-only eval commands appear in routing and help. */
  evalsEnabled: boolean;
  /** The composer's input line + suggestion selection; the suggestion
   * panel derives from it (deriveSuggestions), never stored. */
  composer: ComposerState;
  /** Present only while a run is active (running/cancelling). */
  live?: LiveRunState;
  /** Published artifacts of the current or most recent run, upserted by
   * `entry.filename` in publish order; cleared on run_started, retained
   * after the run ends (/artifacts and the completion summary read it). */
  artifacts: readonly PublishedArtifact[];
  /** Cursor + view of the artifact rail/panel; reset on run_started. */
  artifactUi: ArtifactUiState;
  /** Summary of the last terminal interactive run — the answer/artifact
   * panel's data and its render condition; cleared on run_started. */
  completedRun?: CompletedRunSummary;
  /** Run dir of the most recent run whatever its outcome, retained as
   * the run ends — /artifacts opens retained artifacts against it when
   * no completion summary exists (cancelled runs). */
  lastRunDir?: string;
  /** True while an eval batch owns the session (its runs return to
   * evalsRunning between trials instead of idle). */
  evalsActive?: boolean;
  /** Concurrent eval trials keyed by task name + trial number. */
  evalsLive?: Readonly<Record<string, EvalTrialLive>>;
}
