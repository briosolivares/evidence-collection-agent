import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { ModelRole, RunRoleUsage } from './runBudget.js';
import type { ToolCall } from '../tools/pipeline.js';

// The run's durable checkpoint. Nothing in this repo persists a resumable
// snapshot of a live run today — no checkpoint, no lock file, no `harness/`
// directory exist before this module. It is built standalone: it knows the
// shape of a V2 run (one persistent worker conversation, one whole-run
// budget, a typed output contract, a verifier — see workerSession.ts,
// runBudget.ts, contracts/, and harness/harness.ts) well enough to hold a
// faithful snapshot of it, but it owns none of that machinery itself. A
// later change wires this store into runTask's loop; this module only has
// to make the snapshot durable, exclusive, and honest about corruption.
//
// Naming note: src/harness/harness.ts already writes a root-level FILE at
// <runDir>/harness.json — the harness's own end-of-run diagnostics
// (HarnessDiagnostics). This module's `harness/` is a DIRECTORY at
// <runDir>/harness/, holding run.lock and checkpoint.json. A file and a
// directory can share a stem without colliding on disk, and this module
// never reads or writes harness.json — the two coexist untouched.
//
// Three invariants make the store trustworthy for something that plans to
// resume a live conversation from it:
//   - exclusive ownership (run.lock, exclusive-create). Two harness
//     processes must never mutate the same run directory at once, but a
//     crashed owner's lock must not permanently strand the run either — see
//     acquireRunLock's live/stale/corrupt handling below.
//   - atomic, fsync'd replacement of checkpoint.json. A crash mid-write must
//     never leave a half-written or missing checkpoint; the worst case is
//     losing the in-flight update, never corrupting the one already durable.
//   - a strictly increasing checkpointRevision, so a save built from a stale
//     view of the run can never silently roll committed state backwards.
//
// The store deliberately knows nothing about tools, browsers, or how a run
// executes. `workerSession.messages`, `runProgress.cycleRecords`,
// `pendingTurn.assistantMessage`/`result`, and `finalOutcome` are all opaque
// cargo as far as this module is concerned — validated only as "the right
// shape of container" (an array, a plain object), never interpreted. Their
// real types live in loop/messages.ts, harness/harness.ts, tools/pipeline.ts,
// and run/runOutcome.ts respectively; importing them here would buy no
// operational benefit and risks a needless dependency cycle for fields the
// store only ever round-trips byte-for-byte.

// ---------------------------------------------------------------------------
// The 'unbounded' ceiling sentinel
// ---------------------------------------------------------------------------

/**
 * The literal JSON form of an unbounded budget or turn ceiling.
 * `JSON.stringify` silently turns `Infinity` into `null`, and in a
 * checkpoint a `null` ceiling must never be mistaken for a `0` one — so
 * every ceiling that can legitimately be unbounded is persisted through
 * this sentinel instead of the raw number, and `runCheckpointV1Schema`
 * rejects `null` (and anything else) in its place.
 */
export const UNBOUNDED_CEILING = 'unbounded' as const;

/** A budget or turn ceiling exactly as a checkpoint persists it: a finite
 * number, or the `'unbounded'` sentinel standing in for `Infinity`. */
export type SerializedCeiling = number | typeof UNBOUNDED_CEILING;

const ceilingSchema: z.ZodType<SerializedCeiling> = z.union([
  z.number().finite(),
  z.literal(UNBOUNDED_CEILING),
]);

/**
 * Convert a live ceiling — as RunBudgetConfig and WorkerSessionConfig hold
 * them, where `Infinity` means "no limit" (see runBudget.ts) — to its
 * durable checkpoint form.
 *
 * @throws if given `NaN`: a checkpoint must never persist a value the live
 *   config itself would already have rejected (see
 *   runBudget.validateRunBudgetConfig)
 */
export function ceilingToCheckpoint(value: number): SerializedCeiling {
  if (Number.isNaN(value)) {
    throw new Error('cannot serialize a NaN ceiling to a checkpoint');
  }
  return value === Infinity ? UNBOUNDED_CEILING : value;
}

/** Convert a checkpoint's ceiling back to its live form: the `'unbounded'`
 * sentinel becomes `Infinity`; every other value passes through unchanged. */
export function ceilingFromCheckpoint(value: SerializedCeiling): number {
  return value === UNBOUNDED_CEILING ? Infinity : value;
}

// ---------------------------------------------------------------------------
// RunCheckpointV1 schema
// ---------------------------------------------------------------------------

const isoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 timestamp');

const runStatusSchema = z.enum([
  'initializing',
  'ready_for_model',
  'executing_tools',
  'verifying',
  'terminal',
]);

/** The run's coarse-grained position in the harness loop, as recorded on
 * every checkpoint. */
export type RunCheckpointStatus = z.infer<typeof runStatusSchema>;

// Tied to ModelRole (runBudget.ts) with `satisfies` so this list cannot
// silently drift out of sync with the live budget tracker's role set.
const MODEL_ROLES = ['initializer', 'worker', 'verifier', 'repair'] as const satisfies readonly ModelRole[];
const modelRoleSchema = z.enum(MODEL_ROLES);

const runRoleUsageSchema: z.ZodType<RunRoleUsage> = z.strictObject({
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
});

const runConfigurationHarnessSchema = z.strictObject({
  maxWorkerCycles: z.number().int().positive(),
  maxCompletionCheckFailures: z.number().int().nonnegative(),
  contractAuthor: z.enum(['worker', 'initializer']),
});

const runConfigurationSchema = z.strictObject({
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  maxTurns: ceilingSchema,
  maxContextTokens: z.number().int().nonnegative(),
  startUrl: z.string().min(1).optional(),
  harness: runConfigurationHarnessSchema.optional(),
});

const budgetConfigSchema = z.strictObject({
  maxWorkerTurns: ceilingSchema,
  maxToolCalls: ceilingSchema,
  maxModelTokens: ceilingSchema,
  maxToolResultBytes: ceilingSchema,
  maxWallTimeMs: ceilingSchema,
  maxVerifierCorrections: ceilingSchema,
});

// Partial, not Record: a role with no recorded usage is simply absent (see
// RunBudgetTracker.roleUsage), never present with zeroed fields.
const budgetRolesSchema = z.partialRecord(modelRoleSchema, runRoleUsageSchema);

const budgetSchema = z.strictObject({
  config: budgetConfigSchema,
  // So a restart cannot reset the wall-clock guard back to zero headroom —
  // see the field comment on RunCheckpointV1.budget below.
  elapsedWallTimeMs: z.number().int().nonnegative(),
  roles: budgetRolesSchema,
  toolCalls: z.number().int().nonnegative(),
  toolResultBytes: z.number().int().nonnegative(),
  corrections: z.number().int().nonnegative(),
});

// Mode-scoped fields (proseAccepted/filesWritten for 'prose',
// contractRevision for 'contract') are documented but not cross-validated
// here: that is initializer-domain policy, not a storage invariant the
// checkpoint store itself needs to enforce.
const initializerSchema = z.strictObject({
  mode: z.enum(['prose', 'contract']),
  proseAccepted: z.strictObject({ intent: z.string(), contract: z.string() }).optional(),
  filesWritten: z.boolean().optional(),
  contractRevision: z.number().int().positive().optional(),
});

const workerSessionSchema = z.strictObject({
  // Message[] from loop/messages.ts. Deep-validating that discriminated
  // union here would duplicate messages.ts for no operational benefit — the
  // store's job is to round-trip these exactly, not interpret them — so
  // only "array of plain objects" is enforced.
  messages: z.array(z.looseObject({})),
  turnCount: z.number().int().nonnegative(),
  peakContextTokens: z.number().int().nonnegative(),
  protocolCorrections: z.number().int().nonnegative(),
  startedMs: z.number().int().nonnegative(),
});

const runProgressSchema = z.strictObject({
  currentCycle: z.number().int().nonnegative(),
  completionCheckFailures: z.number().int().nonnegative(),
  // HarnessCycleRecord[] (src/harness/harness.ts) — opaque per-cycle
  // diagnostics the store persists without interpreting.
  cycleRecords: z.array(z.unknown()),
  completedCycleMetrics: z.array(z.unknown()).optional(),
});

// Structurally ToolCall (tools/pipeline.ts): {id, name, input}. Reused as a
// real type via the ZodType annotation below rather than re-declared,
// because it is cheap (a type-only import erases entirely) and it is
// exactly this shape already.
const pendingToolCallRequestSchema: z.ZodType<ToolCall> = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

const pendingToolCallSchema = z.strictObject({
  request: pendingToolCallRequestSchema,
  executionStatus: z.enum(['pending', 'running', 'finished']),
  // ToolCallResult (tools/pipeline.ts) — a discriminated union on isError;
  // left opaque like the other in-flight cargo on this type.
  result: z.unknown().optional(),
});

const pendingTurnSchema = z.strictObject({
  turnNumber: z.number().int().positive(),
  // AssistantMessage (loop/messages.ts).
  assistantMessage: z.unknown(),
  toolCalls: z.array(pendingToolCallSchema),
});

const runCheckpointV1BaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Strictly increasing across every save this store accepts for a run —
   * see openRunCheckpointStore's revision-monotonicity guard. */
  checkpointRevision: z.number().int().positive(),
  runStatus: runStatusSchema,
  updatedAt: isoTimestampSchema,
  runConfiguration: runConfigurationSchema,
  /** The whole-run budget. Its live counters are closure-local in
   * runBudget.ts with no serialization seam, so the checkpoint carries
   * everything needed to restore them without refilling headroom:
   * `elapsedWallTimeMs` in particular exists so a restart cannot reset the
   * wall-clock guard back to zero. */
  budget: budgetSchema,
  initializer: initializerSchema.optional(),
  /** The run's single persistent worker conversation. Required once
   * runStatus leaves 'initializing' — see the superRefine below. Every dep
   * a live WorkerSession needs beyond these plain fields (callModel,
   * registry, browser, credentials, stores, budget) is a live handle
   * re-supplied by the caller on resume, never itself serialized. */
  workerSession: workerSessionSchema.optional(),
  runProgress: runProgressSchema,
  pendingTurn: pendingTurnSchema.optional(),
  // RunOutcome (run/runOutcome.ts).
  finalOutcome: z.unknown().optional(),
});

/**
 * The full RunCheckpointV1 schema, including the one cross-field rule the
 * store itself must enforce: `workerSession` may be absent only while
 * `runStatus` is `'initializing'`. Every later status has already created
 * the persistent worker conversation, so its checkpoint must carry it — a
 * checkpoint claiming otherwise is corrupt, not merely incomplete.
 */
export const runCheckpointV1Schema = runCheckpointV1BaseSchema.superRefine((checkpoint, ctx) => {
  if (checkpoint.runStatus !== 'initializing' && checkpoint.workerSession === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['workerSession'],
      message:
        `workerSession is required once runStatus leaves 'initializing' ` +
        `(runStatus is ${JSON.stringify(checkpoint.runStatus)})`,
    });
  }
});

/** A durable snapshot of a run: enough to resume the run's single
 * persistent worker conversation, whole-run budget, and harness/verifier
 * position after a crash or restart. See the module comment for the
 * architecture this reflects and which fields stay deliberately opaque. */
export type RunCheckpointV1 = z.infer<typeof runCheckpointV1Schema>;

// ---------------------------------------------------------------------------
// The run lock
// ---------------------------------------------------------------------------

/** The contents of harness/run.lock: who currently holds the exclusive
 * right to mutate this run's checkpoint. */
export interface RunLockFile {
  /** Identifies the specific openRunCheckpointStore() call that holds the
   * lock — not just the OS process, so a save() can detect the lock being
   * reassigned to a *different* store instance even within the same
   * process (see the "changed lock cancels further mutation" rule). */
  harnessInstanceId: string;
  /** OS process id of the holder, checked for liveness
   * (`process.kill(pid, 0)`) when a later open() finds the lock already
   * present. */
  processId: number;
  /** ISO 8601 timestamp of acquisition, for a human inspecting a stuck
   * lock. */
  acquiredAt: string;
}

const runLockFileSchema: z.ZodType<RunLockFile> = z.strictObject({
  harnessInstanceId: z.string().min(1),
  processId: z.number().int().positive(),
  acquiredAt: isoTimestampSchema,
});

// ---------------------------------------------------------------------------
// Filesystem layout and durability primitives
// ---------------------------------------------------------------------------

/** Run-dir subdirectory holding the checkpoint store's own files. Distinct
 * from src/harness/harness.ts's `harness.json` FILE at the run-dir root —
 * see the module comment for how the two coexist. */
export const HARNESS_DIR = 'harness';

/** Name of the exclusive lock file inside HARNESS_DIR. */
export const RUN_LOCK_FILENAME = 'run.lock';

/** Name of the durable checkpoint file inside HARNESS_DIR. */
export const RUN_CHECKPOINT_FILENAME = 'checkpoint.json';

/** Name of the temporary file the atomic-replace sequence stages through
 * before renaming over RUN_CHECKPOINT_FILENAME. `load()` never reads this
 * path — a leftover one (e.g. from a crash before rename) is simply
 * ignored. */
export const RUN_CHECKPOINT_TMP_FILENAME = `${RUN_CHECKPOINT_FILENAME}.tmp`;

/** Directory mode for HARNESS_DIR: owner-only read/write/execute. Defence
 * in depth for a shared host, not a sandbox boundary — anyone who can run
 * code as this OS user can already read and write anything this process
 * can reach, mode bits or not. */
const HARNESS_DIR_MODE = 0o700;

/** File mode for every file the store writes inside HARNESS_DIR: owner-only
 * read/write. Same defence-in-depth caveat as HARNESS_DIR_MODE. */
const HARNESS_FILE_MODE = 0o600;

/** Create HARNESS_DIR if absent (mode 0700, chmod'd explicitly afterward
 * since mkdir's mode option is still subject to umask), or validate an
 * existing one rather than silently re-permissioning it — a loosened mode
 * on a shared host is worth failing on, not papering over. */
function ensureHarnessDir(runDir: string): string {
  const harnessDir = join(runDir, HARNESS_DIR);
  let stats;
  try {
    stats = statSync(harnessDir);
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code !== 'ENOENT') throw thrown;
    mkdirSync(harnessDir, { mode: HARNESS_DIR_MODE });
    chmodSync(harnessDir, HARNESS_DIR_MODE);
    return harnessDir;
  }
  if (!stats.isDirectory()) {
    throw new Error(`${harnessDir} exists and is not a directory`);
  }
  const mode = stats.mode & 0o777;
  if (mode !== HARNESS_DIR_MODE) {
    throw new Error(
      `${harnessDir} exists with mode 0${mode.toString(8)}, expected 0${HARNESS_DIR_MODE.toString(8)}. ` +
        'Refusing to silently re-permission an existing directory — fix the mode by hand ' +
        '(these bits are defence-in-depth for a shared host, not a sandbox boundary, but a ' +
        'loosened mode here is worth a human looking at).',
    );
  }
  return harnessDir;
}

function lockFilePath(harnessDir: string): string {
  return join(harnessDir, RUN_LOCK_FILENAME);
}

/** Format a ZodError as one bullet per issue, path-qualified — matches the
 * pipeline's own invalid-input reporting style (tools/pipeline.ts). */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `- at ${path}: ${issue.message}`;
    })
    .join('\n');
}

/** Read and validate harness/run.lock. Returns undefined when absent;
 * throws — leaving the file untouched — when it exists but is not valid
 * JSON matching RunLockFile, so a corrupt lock fails loudly instead of
 * being silently reinterpreted or discarded. */
function readLockFile(harnessDir: string): RunLockFile | undefined {
  const lockPath = lockFilePath(harnessDir);
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw thrown;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (thrown) {
    throw new Error(`run lock at ${lockPath} is not valid JSON: ${(thrown as Error).message}`);
  }
  const parsed = runLockFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `run lock at ${lockPath} failed schema validation:\n${formatZodIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** True iff `pid` names a live process, checked the only portable way
 * Node offers: sending signal 0 (no-op — delivers nothing, just probes).
 * ESRCH means no such process; anything else (most notably EPERM, meaning
 * the process exists but is owned by someone else) is treated as live,
 * because we cannot prove otherwise. A live false positive only blocks
 * stale-lock recovery (safe); a dead false negative would let a new
 * harness steal a live run's lock (unsafe) — see the PID-reuse note in the
 * module comment. */
function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Acquire harness/run.lock exclusively before any mutable state is loaded.
 *
 * Ownership rules: a well-formed lock owned by a live process blocks this
 * open outright. A lock whose owning process is gone (or that vanished
 * between our failed create and our read of it) is stale — it is removed
 * and creation is retried exactly once; a second collision means another
 * process won the recovery race, and this open fails rather than looping
 * or stealing the run. A corrupt lock (readLockFile throws) fails loudly
 * and is left exactly where it was for a human to inspect.
 */
function acquireRunLock(harnessDir: string, instanceId: string, now: () => number): void {
  const lockPath = lockFilePath(harnessDir);
  const content: RunLockFile = {
    harnessInstanceId: instanceId,
    processId: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  const serialized = `${JSON.stringify(content, null, 2)}\n`;

  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, serialized, { flag: 'wx', mode: HARNESS_FILE_MODE });
      chmodSync(lockPath, HARNESS_FILE_MODE);
      return true;
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw thrown;
    }
  };

  if (tryCreate()) return;

  const existing = readLockFile(harnessDir);
  if (existing !== undefined && isProcessLive(existing.processId)) {
    throw new Error(
      `run at ${harnessDir} is already open: lock held by pid ${existing.processId} ` +
        `(harness instance ${existing.harnessInstanceId}, acquired ${existing.acquiredAt}). ` +
        'Refusing to open the same run from two processes at once.',
    );
  }

  // Stale (or the lock vanished between our failed create and this read).
  // Clear it and retry creation exactly once.
  if (existing !== undefined) unlinkSync(lockPath);
  if (!tryCreate()) {
    throw new Error(
      `could not acquire the run lock at ${lockPath}: another process claimed it during ` +
        'stale-lock recovery',
    );
  }
}

/** Release the lock, but only if it still names this instance. Best-effort
 * and defensive: if it is already gone, or has been reassigned (the case a
 * save() would already have poisoned the store over), there is nothing
 * safe left to reclaim. A corrupt lock is left alone here too, matching
 * acquireRunLock's stance. */
function releaseLock(harnessDir: string, instanceId: string): void {
  let existing: RunLockFile | undefined;
  try {
    existing = readLockFile(harnessDir);
  } catch {
    return;
  }
  if (existing?.harnessInstanceId === instanceId) {
    rmSync(lockFilePath(harnessDir), { force: true });
  }
}

/** Read and validate harness/checkpoint.json. Returns undefined when
 * absent (a fresh run); throws when present but invalid — a present-but-
 * invalid checkpoint is never treated as "start a fresh conversation
 * against this run directory". Never reads the .tmp staging file. */
function readCheckpointFile(checkpointPath: string): RunCheckpointV1 | undefined {
  let raw: string;
  try {
    raw = readFileSync(checkpointPath, 'utf8');
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw thrown;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (thrown) {
    throw new Error(
      `checkpoint at ${checkpointPath} is not valid JSON: ${(thrown as Error).message}`,
    );
  }
  const parsed = runCheckpointV1Schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `checkpoint at ${checkpointPath} failed schema validation — a present-but-invalid ` +
        `checkpoint is never a reason to start fresh:\n${formatZodIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Write `data` to `path`, fsync the file descriptor, then close it — the
 * "flush the temp file" half of the atomic-replace sequence. `fchmodSync`
 * pins the exact mode regardless of umask (open()'s mode argument, like
 * mkdir's, is still masked by it). */
function writeFileDurable(path: string, data: string, mode: number): void {
  const fd = openSync(path, 'w', mode);
  try {
    writeSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flush a directory's own metadata (the rename just performed inside it)
 * where the platform supports fsync on a directory file descriptor.
 * Notably not Windows — the rename above is still durable there through
 * NTFS's own journal, so a failure here is only extra insurance we could
 * not buy, never fatal. */
function fsyncDirectoryBestEffort(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // Best-effort, as documented above.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Durable access to one run's checkpoint. Owns exactly three files —
 * harness/run.lock, harness/checkpoint.json, and its .tmp staging copy —
 * and nothing about how the run executes. */
export interface RunCheckpointStore {
  /** The current checkpoint, or undefined if none has ever been saved for
   * this run. Throws if a checkpoint file exists but fails schema
   * validation (see readCheckpointFile). Synchronous: a plain file read. */
  load(): RunCheckpointV1 | undefined;
  /**
   * Validate and durably persist a checkpoint, replacing the previous one
   * atomically.
   *
   * Saves are serialized: a save queued behind another does not begin its
   * own work until the prior one has fully settled (success or failure).
   * Rejects if `checkpoint` fails schema validation, if
   * `checkpoint.checkpointRevision` is not strictly greater than the last
   * revision this store accepted, if the store is closed, or if
   * harness/run.lock no longer names this store's instance (which also
   * cancels every later save on this store — see openRunCheckpointStore).
   */
  save(checkpoint: RunCheckpointV1): Promise<void>;
  /** Idempotent shutdown: waits for any in-flight or already-queued save to
   * settle, rejects every save requested after this call, then releases
   * the lock last. Safe to call more than once — later calls resolve the
   * same completion. */
  close(): Promise<void>;
}

/**
 * Open (or create) the durable checkpoint store for one run directory.
 *
 * Acquires harness/run.lock exclusively before loading any mutable state
 * (see acquireRunLock), so a second open on the same run directory either
 * fails outright (a live owner) or safely recovers a stale one — it can
 * never silently share ownership with another open store.
 *
 * @param runDir - absolute path of an existing run directory (see
 *   runDir.createRunDir); HARNESS_DIR is created under it if absent
 * @param opts.now - test seam for the clock behind `run.lock`'s
 *   `acquiredAt`, mirroring runBudget.createRunBudgetTracker's `opts.now`;
 *   defaults to `Date.now`
 * @param opts.beforeWrite - test seam awaited at the start of every queued
 *   save, before it touches disk or re-checks the lock; defaults to a
 *   no-op. Exists so tests can open a controllable window and prove
 *   concurrent `save()` calls serialize rather than race
 * @param opts.afterTempWrite - test seam called synchronously after the
 *   temp file is written and flushed but before the atomic rename;
 *   defaults to a no-op. Exists so tests can inject a crash in exactly that
 *   window and confirm the previous checkpoint survives untouched
 */
export async function openRunCheckpointStore(
  runDir: string,
  opts: {
    now?: () => number;
    beforeWrite?: () => void | Promise<void>;
    afterTempWrite?: () => void;
  } = {},
): Promise<RunCheckpointStore> {
  const now = opts.now ?? Date.now;
  const harnessDir = ensureHarnessDir(runDir);
  const checkpointPath = join(harnessDir, RUN_CHECKPOINT_FILENAME);
  const tmpPath = join(harnessDir, RUN_CHECKPOINT_TMP_FILENAME);
  const instanceId = randomUUID();

  acquireRunLock(harnessDir, instanceId, now);

  // Seed from whatever is already durable, so a reopened store — even in a
  // fresh process, after a crash — can never accept a save that would roll
  // committed state backwards. Also the reason a present-but-invalid
  // checkpoint fails as early as opening the store, not just on load().
  let lastRevision = readCheckpointFile(checkpointPath)?.checkpointRevision;
  // Set once harness/run.lock is found missing or reassigned during a
  // save: every later save on this store fails immediately with the same
  // error, matching the "cancels further mutation" requirement — a save
  // that can no longer prove exclusive ownership must never be retried
  // into believing ownership came back.
  let poisonedError: Error | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  // The serialization queue: each save() chains onto this, and always
  // leaves it in a non-rejecting state so one failed save cannot wedge
  // every save queued after it.
  let queueTail: Promise<void> = Promise.resolve();

  async function performSave(checkpoint: RunCheckpointV1): Promise<void> {
    const parsed = runCheckpointV1Schema.safeParse(checkpoint);
    if (!parsed.success) {
      throw new Error(`refusing to save an invalid checkpoint:\n${formatZodIssues(parsed.error)}`);
    }
    const validated = parsed.data;

    if (lastRevision !== undefined && validated.checkpointRevision <= lastRevision) {
      throw new Error(
        `checkpointRevision ${validated.checkpointRevision} must be strictly greater than the ` +
          `last saved revision ${lastRevision} — refusing to overwrite newer state with older`,
      );
    }

    let currentLock: RunLockFile | undefined;
    try {
      currentLock = readLockFile(harnessDir);
    } catch (thrown) {
      poisonedError = thrown instanceof Error ? thrown : new Error(String(thrown));
      throw poisonedError;
    }
    if (currentLock === undefined || currentLock.harnessInstanceId !== instanceId) {
      poisonedError = new Error(
        `run lock in ${harnessDir} is missing or now held by a different harness instance; ` +
          'cancelling further checkpoint mutation for this store',
      );
      throw poisonedError;
    }

    // Serialize before touching the existing file: a checkpoint that fails
    // to stringify must never get the chance to half-overwrite the last
    // good one.
    const data = `${JSON.stringify(validated, null, 2)}\n`;
    writeFileDurable(tmpPath, data, HARNESS_FILE_MODE);
    opts.afterTempWrite?.();
    renameSync(tmpPath, checkpointPath);
    fsyncDirectoryBestEffort(harnessDir);

    lastRevision = validated.checkpointRevision;
  }

  return {
    load: () => readCheckpointFile(checkpointPath),

    save(checkpoint: RunCheckpointV1): Promise<void> {
      if (closed) {
        return Promise.reject(
          new Error(`cannot save: checkpoint store for ${runDir} is already closed`),
        );
      }
      if (poisonedError !== undefined) {
        return Promise.reject(poisonedError);
      }
      const task = queueTail.then(async () => {
        // Re-check: the store may have been poisoned by the save this one
        // was queued behind.
        if (poisonedError !== undefined) throw poisonedError;
        await opts.beforeWrite?.();
        await performSave(checkpoint);
      });
      // The chain must keep advancing even when this save fails — only the
      // caller's own `task` promise carries that failure.
      queueTail = task.catch(() => undefined);
      return task;
    },

    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = queueTail.then(() => {
          releaseLock(harnessDir, instanceId);
        });
      }
      return closePromise;
    },
  };
}
