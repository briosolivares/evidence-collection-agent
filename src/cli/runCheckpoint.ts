import {
  captureWorkerSessionSnapshot,
  type WorkerSession,
} from '../loop/workerSession.js';
import { captureRunBudgetSnapshot, type RunBudgetTracker } from '../run/runBudget.js';
import {
  ceilingToCheckpoint,
  type RunCheckpointStore,
  type RunCheckpointV1,
} from '../run/runCheckpointStore.js';

// A focused writer over RunCheckpointStore: it owns exactly two things the
// store itself deliberately does not — the monotonically increasing
// `checkpointRevision` every save must carry, and the mechanical work of
// turning LIVE objects (a WorkerSession, a RunBudgetTracker) into the plain,
// schema-valid snapshots runCheckpointV1Schema accepts. Nothing here decides
// WHEN to save or what runStatus a given moment in the harness loop is in —
// that is runTask.ts's call, made at the specific boundaries documented on
// each method below. Splitting the concerns this way is what keeps
// runTask.ts's own loop readable: every save call there reads as "persist
// what's true right now", not as sixty lines of schema assembly repeated at
// each call site.
//
// Every method here maps to exactly one `runCheckpointV1Schema` runStatus:
//
//   saveInitializing        -> 'initializing', no workerSession yet
//   saveInitializerAccepted -> 'initializing', `initializer` now recorded
//                               and carried forward on every later save
//   saveReadyForModel       -> 'ready_for_model'
//   saveVerifying           -> 'verifying'
//   saveTerminal            -> 'terminal'
//
// One runStatus in the schema — 'executing_tools' — is never produced by
// this writer at all. That is not an oversight: `scheduleToolCalls` (the
// only place tool calls actually execute, inside `runWorkerSession.ts`'s
// `runWorkerTurn`) accepts lifecycle hooks that COULD checkpoint around each
// call, but `runWorkerTurn` is called without them and this task does not
// touch loop/workerSession.ts to wire them up. The honest consequence: a
// crash mid-turn — between one `ready_for_model` (or `verifying`) save and
// the next — is recovered by treating the WHOLE in-flight turn as if it
// never started, never at per-call granularity. See runTask.ts's own module
// note on `runHarnessCycles` for exactly which turn that is on resume, and
// resumeTask's module note for the fault windows this leaves open (a
// partially-executed tool batch, and any output-table rows or evidence
// records minted after the last save, which live only in this process's
// memory and are never part of this checkpoint).

/** Everything needed to assemble a checkpoint besides the moment-specific
 * arguments each `save*` method takes: this run's static configuration
 * (stamped onto every checkpoint unchanged — see runTask.ts's
 * `buildCheckpointRunConfiguration`) and the run's single whole-run budget
 * tracker. One `RunBudgetTracker` instance lives for a harness run's entire
 * life (see runBudget.ts), so the writer reads its LIVE state fresh on every
 * save via `captureRunBudgetSnapshot` rather than making every caller
 * re-supply it. */
export interface RunCheckpointWriterConfig {
  /** This run's configuration exactly as `runCheckpointV1Schema` wants it:
   * ceilings already converted through `ceilingToCheckpoint` (`maxTurns` in
   * particular — it never changes over the run's life, so converting it
   * once here is simpler than re-deriving it on every save). */
  runConfiguration: RunCheckpointV1['runConfiguration'];
  /** The run's single whole-run budget tracker, shared with every model
   * role. */
  budget: RunBudgetTracker;
  /** Test seam for the clock behind `updatedAt`; defaults to `Date.now`,
   * mirroring every other test seam in this run's modules
   * (openRunCheckpointStore's `opts.now`, createRunBudgetTracker's
   * `opts.now`). */
  now?: () => number;
}

/** The run's progress within the harness loop: which cycle, how many
 * automated-check rejections it has spent, and the per-cycle diagnostic
 * trail so far. Re-exported verbatim from the checkpoint schema's own type
 * rather than redeclared, so the two can never drift apart. */
export type RunProgress = RunCheckpointV1['runProgress'];

/** The full `initializer` record a checkpoint may carry — re-exported from
 * the schema's own (optional) field so `saveInitializerAccepted`'s parameter
 * type can never drift from what `runCheckpointV1Schema` actually accepts. */
export type CheckpointInitializer = NonNullable<RunCheckpointV1['initializer']>;

/**
 * Durable checkpointing for one harness-mode run, layered over a
 * `RunCheckpointStore`. See the module comment for the runStatus each method
 * writes and for exactly which fault windows this leaves open.
 */
export interface RunCheckpointWriter {
  /** Before the initializer's own model call: `runStatus: 'initializing'`,
   * no `initializer` field yet (nothing has been accepted), no
   * `workerSession` (none exists). */
  saveInitializing(): Promise<void>;
  /**
   * After the initializer phase accepts something durable, still
   * `runStatus: 'initializing'`. Called more than once on the prose path —
   * once with the accepted `{intent, contract}` BEFORE the files are
   * written, once more with `filesWritten: true` after — so a crash between
   * the two lets resumeTask finish the (deterministic, model-free) file
   * writes without re-asking the initializer. See runTask.ts's initializer
   * block for exactly where each call sits.
   */
  saveInitializerAccepted(initializer: CheckpointInitializer): Promise<void>;
  /** Once the `WorkerSession` exists, and again every time the harness loop
   * is about to ask the model for another turn (a fresh cycle, a retry
   * after a rejected submission, or a correction round) — see runTask.ts's
   * `runHarnessCycles` for the single rule that covers all three. */
  saveReadyForModel(args: { session: WorkerSession; progress: RunProgress }): Promise<void>;
  /** After a worker cycle produces a completion or submission that already
   * passed any automated checks, and BEFORE `runVerifier` runs. Re-running
   * the (read-only) verifier after a crash is acceptable and cheap;
   * re-running the worker cycle that already finished is neither — this is
   * the checkpoint that lets resumeTask tell the two apart. */
  saveVerifying(args: { session: WorkerSession; progress: RunProgress }): Promise<void>;
  /** The run's final state: `runStatus: 'terminal'`, `finalOutcome` set to
   * the truthful `RunOutcome`. `session` is optional only for interface
   * symmetry with a theoretical harness-less terminal state; every call
   * this codebase makes has one, since a terminal outcome is only ever
   * reached after a `WorkerSession` exists. */
  saveTerminal(args: {
    session?: WorkerSession;
    progress: RunProgress;
    outcome: unknown;
  }): Promise<void>;
  /** Idempotent shutdown: delegates to the underlying store's own
   * idempotent `close()`. */
  close(): Promise<void>;
}

/** A `runProgress` with nothing to report yet — used by the two
 * 'initializing' saves, before any cycle has started. */
const NO_PROGRESS: RunProgress = { currentCycle: 0, completionCheckFailures: 0, cycleRecords: [] };

/**
 * Build a `RunCheckpointWriter` over an already-open `RunCheckpointStore`.
 *
 * @param store - see `openRunCheckpointStore`; this writer performs no
 *   locking or file I/O of its own, only `store.save()` calls
 * @param config - see `RunCheckpointWriterConfig`
 */
export function createRunCheckpointWriter(
  store: RunCheckpointStore,
  config: RunCheckpointWriterConfig,
): RunCheckpointWriter {
  const now = config.now ?? Date.now;

  // Seeded from whatever is already durable, NOT hardcoded to zero: a fresh
  // `RunCheckpointStore.save` requires every checkpointRevision to be
  // strictly greater than the last one IT accepted, and that "last one" can
  // already be nonzero here — resumeTask opens a brand-new writer over a
  // store that already holds every checkpoint the interrupted run saved.
  // Seeding from zero would make this writer's very first save (revision 1)
  // collide with whatever the run had already reached, rejected by the
  // store as "older than what's on disk".
  const seed = store.load();
  let revision = seed?.checkpointRevision ?? 0;

  // Carried forward once accepted: every save after `saveInitializerAccepted`
  // must keep restating it, because a checkpoint is a complete snapshot, not
  // a diff — `runCheckpointV1Schema` has no notion of "unchanged since last
  // time". Seeded the same way as `revision`, so a resumed run's writer
  // keeps recording an initializer phase that already finished before this
  // writer instance existed.
  let initializer: CheckpointInitializer | undefined = seed?.initializer;

  function assembleBudget(): RunCheckpointV1['budget'] {
    const tracker = config.budget;
    const snapshot = captureRunBudgetSnapshot(tracker);
    return {
      config: {
        maxWorkerTurns: ceilingToCheckpoint(tracker.config.maxWorkerTurns),
        maxToolCalls: ceilingToCheckpoint(tracker.config.maxToolCalls),
        maxModelTokens: ceilingToCheckpoint(tracker.config.maxModelTokens),
        maxToolResultBytes: ceilingToCheckpoint(tracker.config.maxToolResultBytes),
        maxWallTimeMs: ceilingToCheckpoint(tracker.config.maxWallTimeMs),
        maxVerifierCorrections: ceilingToCheckpoint(tracker.config.maxVerifierCorrections),
      },
      elapsedWallTimeMs: snapshot.elapsedWallTimeMs,
      roles: snapshot.roles,
      toolCalls: snapshot.toolCalls,
      toolResultBytes: snapshot.toolResultBytes,
      corrections: snapshot.corrections,
    };
  }

  function assembleSession(
    session: WorkerSession,
  ): NonNullable<RunCheckpointV1['workerSession']> {
    const snapshot = captureWorkerSessionSnapshot(session);
    return {
      // Deliberately opaque cargo as far as this module and the checkpoint
      // schema are concerned (see runCheckpointStore.ts's module comment):
      // the schema validates "array of plain objects", never Message's real
      // shape, so a structural cast is the honest way to cross that
      // boundary rather than pretending the schema's loose element type is
      // Message itself.
      messages: snapshot.messages as unknown as NonNullable<
        RunCheckpointV1['workerSession']
      >['messages'],
      turnCount: snapshot.turnCount,
      peakContextTokens: snapshot.peakContextTokens,
      protocolCorrections: snapshot.protocolCorrections,
      startedMs: snapshot.startedMs,
    };
  }

  /** The fields every checkpoint carries regardless of status: a fresh
   * revision, a fresh timestamp, this run's unchanging configuration, and
   * the budget's CURRENT live state. */
  function baseFields(
    runStatus: RunCheckpointV1['runStatus'],
  ): Pick<
    RunCheckpointV1,
    'schemaVersion' | 'checkpointRevision' | 'runStatus' | 'updatedAt' | 'runConfiguration' | 'budget' | 'initializer'
  > {
    revision += 1;
    return {
      schemaVersion: 1,
      checkpointRevision: revision,
      runStatus,
      updatedAt: new Date(now()).toISOString(),
      runConfiguration: config.runConfiguration,
      budget: assembleBudget(),
      ...(initializer === undefined ? {} : { initializer }),
    };
  }

  return {
    async saveInitializing(): Promise<void> {
      await store.save({
        ...baseFields('initializing'),
        runProgress: NO_PROGRESS,
      });
    },

    async saveInitializerAccepted(next: CheckpointInitializer): Promise<void> {
      initializer = next;
      await store.save({
        ...baseFields('initializing'),
        runProgress: NO_PROGRESS,
      });
    },

    async saveReadyForModel({ session, progress }): Promise<void> {
      await store.save({
        ...baseFields('ready_for_model'),
        workerSession: assembleSession(session),
        runProgress: progress,
      });
    },

    async saveVerifying({ session, progress }): Promise<void> {
      await store.save({
        ...baseFields('verifying'),
        workerSession: assembleSession(session),
        runProgress: progress,
      });
    },

    async saveTerminal({ session, progress, outcome }): Promise<void> {
      await store.save({
        ...baseFields('terminal'),
        ...(session === undefined ? {} : { workerSession: assembleSession(session) }),
        runProgress: progress,
        finalOutcome: outcome,
      });
    },

    close: () => store.close(),
  };
}
