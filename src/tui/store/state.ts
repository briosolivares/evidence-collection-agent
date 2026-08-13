// The session store's data model (design "Data Models"): finalized
// transcript items (append-only — they drive Ink's <Static>, which never
// re-renders an item), the live run state that stays mutable until
// finalized, and the single UiEvent stream the reducer consumes.

import type { ManifestEntry } from '../../run/artifacts.js';

/** Interaction modes; overlays are modes so exactly one surface owns input. */
export type SessionMode =
  | 'idle'
  | 'running'
  | 'cancelling'
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
  sourceUrl?: string;
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
  requiresAuth: boolean;
  status: string;
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
  | { kind: 'evidence'; line: string; sourceUrl?: string; verbose?: { input: string; result: string } }
  | { kind: 'completion'; verb: string; elapsedMs: number; tokens: number; runDir: string }
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
  /** Current turn number. */
  turn: number;
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
  | { type: 'turn_end'; usage: { input: number; output: number; cacheRead?: number } }
  | {
      type: 'run_finished';
      outcome: 'completed' | 'budget_exceeded';
      finalText?: string;
      runDir: string;
      /** Which guard tripped, on budget_exceeded. */
      reason?: string;
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
  /** Completion-line verb, fixed at session start from config (R6). */
  completionVerb: string;
  /** Present only while a run is active (running/cancelling). */
  live?: LiveRunState;
  /** Published artifacts of the current or most recent run, upserted by
   * `entry.filename` in publish order; cleared on run_started, retained
   * after the run ends (/artifacts and the completion summary read it). */
  artifacts: readonly PublishedArtifact[];
  /** Cursor + view of the artifact rail/panel; reset on run_started. */
  artifactUi: ArtifactUiState;
  /** True while an eval batch owns the session (its runs return to
   * evalsRunning between trials instead of idle). */
  evalsActive?: boolean;
  /** Concurrent eval trials keyed by task name + trial number. */
  evalsLive?: Readonly<Record<string, EvalTrialLive>>;
}
