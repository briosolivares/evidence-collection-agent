import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { writeFileDurablyAtomic } from '../run/atomicFile.js';
import {
  canonicalJson,
  checkpointSchema,
  runLockFileSchema,
  UNBOUNDED_CEILING,
  type Checkpoint,
  type CheckpointPhase,
  type DurableRunConfiguration,
  type RunLockFile,
} from './checkpoint.schema.js';

export const HARNESS_DIR = 'harness';
export const RUN_LOCK_FILENAME = 'run.lock';
export const RUN_CHECKPOINT_FILENAME = 'checkpoint.json';
/** Finite pre-parse allocation ceiling for durable checkpoint state. */
export const CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Short-lived compare/delete guard used only while replacing a stale run
 * lock. It is intentionally not auto-recovered: if a process dies in this
 * tiny critical section, a later operator must inspect the run instead of a
 * second process guessing that it is safe to delete another contender's
 * guard.
 */
export const RUN_LOCK_RECOVERY_FILENAME = 'run.lock.recovery';

const HARNESS_DIR_MODE = 0o700;
const HARNESS_FILE_MODE = 0o600;
const CHECKPOINT_READ_CHUNK_BYTES = 64 * 1024;

export type SerializedCeiling = number | typeof UNBOUNDED_CEILING;

export function ceilingToCheckpoint(value: number): SerializedCeiling {
  if (value === Infinity) return UNBOUNDED_CEILING;
  if (!Number.isFinite(value)) {
    throw new Error(`cannot serialize non-finite checkpoint ceiling ${value}`);
  }
  return value;
}

export function ceilingFromCheckpoint(value: SerializedCeiling): number {
  return value === UNBOUNDED_CEILING ? Infinity : value;
}

type DeepReadonly<T> = T extends readonly (infer Child)[]
  ? readonly DeepReadonly<Child>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** Detached, recursively frozen configuration observed before resume opens
 * the mutating checkpoint store. The coordinator still re-reads and
 * revalidates the complete checkpoint after acquiring the run lock. */
export type ReadonlyDurableRunConfiguration = DeepReadonly<DurableRunConfiguration>;

/** Minimal, immutable composition-time view used to route a resume
 * without exposing or mutating the checkpoint's actionable cargo. */
export interface CheckpointResumeInfo {
  readonly phase: CheckpointPhase;
  readonly configuration: ReadonlyDurableRunConfiguration;
}

const VALID_PHASE_TRANSITIONS: Readonly<Record<CheckpointPhase, readonly CheckpointPhase[]>> = {
  initializing: ['initializing', 'ready_for_model', 'terminal'],
  ready_for_model: ['ready_for_model', 'executing_tool', 'checking', 'terminal'],
  executing_tool: ['executing_tool', 'ready_for_model', 'terminal'],
  checking: ['ready_for_model', 'verifying', 'terminal'],
  verifying: ['verifying', 'ready_for_model', 'terminal'],
  terminal: [],
};

export interface CheckpointStoreOptions {
  now?: () => number;
  /** Queue/serialization test seam, before ownership is rechecked. */
  beforeWrite?: () => void | Promise<void>;
  /** Concurrency test seam invoked while the stale-lock recovery guard is held. */
  beforeStaleLockUnlink?: () => void;
  /** Crash-window test seam: flushed temp exists, destination is unchanged. */
  afterTempFileSync?: (tempPath: string) => void;
}

export interface CheckpointStore {
  load(): Checkpoint | undefined;
  save(checkpoint: Checkpoint): Promise<void>;
  close(): Promise<void>;
}

/**
 * Observe the immutable configuration of an existing run without taking
 * its lock or changing any run-directory state. This is deliberately only a
 * composition-time hint: resume must still open the checkpoint store and
 * revalidate the checkpoint under its exclusive lock before doing work.
 *
 * The complete checkpoint is read through the same schema as the store, with
 * a finite byte ceiling and no-follow regular-file checks. The returned value
 * is detached from the parsed checkpoint and recursively frozen.
 */
export function readCheckpointConfiguration(runDir: string): ReadonlyDurableRunConfiguration {
  return readCheckpointResumeInfo(runDir).configuration;
}

/** Observe the checkpoint phase together with its immutable configuration.
 * Terminal resumes use this hint to avoid constructing a new external trace;
 * the coordinator still re-reads and validates the full checkpoint under its
 * exclusive run lock before trusting either value. */
export function readCheckpointResumeInfo(runDir: string): Readonly<CheckpointResumeInfo> {
  assertRealRunDirectory(runDir);
  const harnessDir = existingHarnessDirectory(runDir);
  const checkpointPath = join(harnessDir, RUN_CHECKPOINT_FILENAME);
  const checkpoint = readCheckpointFile(checkpointPath);
  if (checkpoint === undefined) {
    throw new Error(`checkpoint does not exist at ${checkpointPath}`);
  }
  return Object.freeze({
    phase: checkpoint.phase,
    configuration: deepFreeze(checkpoint.configuration),
  });
}

/**
 * Open one exclusively locked checkpoint store. Saves are schema-checked,
 * serialized, monotonic, configuration/contract immutable, and published via
 * fsync + same-directory atomic rename + parent-directory fsync.
 */
export async function openCheckpointStore(
  runDir: string,
  options: CheckpointStoreOptions = {},
): Promise<CheckpointStore> {
  assertRealRunDirectory(runDir);

  const now = options.now ?? Date.now;
  const harnessDir = ensureHarnessDirectory(runDir);
  const checkpointPath = join(harnessDir, RUN_CHECKPOINT_FILENAME);
  const instanceId = randomUUID();

  acquireRunLock(harnessDir, instanceId, now, options.beforeStaleLockUnlink);

  let seed: Checkpoint | undefined;
  try {
    seed = readCheckpointFile(checkpointPath);
  } catch (error) {
    releaseRunLock(harnessDir, instanceId);
    throw error;
  }

  let lastRevision = seed?.revision;
  let lastPhase = seed?.phase;
  let durableConfiguration = seed?.configuration;
  let durableContract = seed?.contract;
  let poisonedError: Error | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let queueTail: Promise<void> = Promise.resolve();

  async function performSave(checkpoint: Checkpoint): Promise<void> {
    if (lastRevision !== undefined && checkpoint.revision <= lastRevision) {
      throw new Error(
        `checkpoint revision ${checkpoint.revision} must be strictly greater than ` +
          `the last saved revision ${lastRevision}`,
      );
    }
    if (lastPhase !== undefined && !VALID_PHASE_TRANSITIONS[lastPhase].includes(checkpoint.phase)) {
      throw new Error(
        `invalid checkpoint phase transition ${lastPhase} -> ${checkpoint.phase}; ` +
          (lastPhase === 'terminal'
            ? 'terminal is absorbing'
            : `allowed next phases are ${VALID_PHASE_TRANSITIONS[lastPhase].join(', ')}`),
      );
    }

    if (
      durableConfiguration !== undefined &&
      canonicalJson(checkpoint.configuration) !== canonicalJson(durableConfiguration)
    ) {
      throw new Error('refusing to change immutable run configuration');
    }
    if (durableContract !== undefined) {
      if (checkpoint.contract === undefined) {
        throw new Error('refusing to remove the accepted immutable output contract');
      }
      if (canonicalJson(checkpoint.contract) !== canonicalJson(durableContract)) {
        throw new Error('refusing to change the accepted immutable output contract');
      }
    }

    assertRunLockOwner(harnessDir, instanceId);
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    writeFileDurablyAtomic(checkpointPath, serialized, {
      fileMode: HARNESS_FILE_MODE,
      ...(options.afterTempFileSync === undefined
        ? {}
        : { afterTempFileSync: options.afterTempFileSync }),
    });

    lastRevision = checkpoint.revision;
    lastPhase = checkpoint.phase;
    durableConfiguration = checkpoint.configuration;
    durableContract = checkpoint.contract;
  }

  return {
    load: () => readCheckpointFile(checkpointPath),

    save(checkpoint: Checkpoint): Promise<void> {
      if (closed) return Promise.reject(new Error('checkpoint store is already closed'));
      if (poisonedError !== undefined) return Promise.reject(poisonedError);

      const parsed = checkpointSchema.safeParse(checkpoint);
      if (!parsed.success) {
        return Promise.reject(
          new Error(`refusing to save an invalid checkpoint:\n${formatZodIssues(parsed.error)}`),
        );
      }
      // Zod returns fresh containers, preventing caller mutation while this
      // save waits behind an earlier queued write.
      const validated = parsed.data;
      const task = queueTail.then(async () => {
        if (poisonedError !== undefined) throw poisonedError;
        await options.beforeWrite?.();
        try {
          await performSave(validated);
        } catch (error) {
          if (isLockOwnershipError(error)) {
            poisonedError = error instanceof Error ? error : new Error(String(error));
          }
          throw error;
        }
      });
      queueTail = task.catch(() => undefined);
      return task;
    },

    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = queueTail.then(() => releaseRunLock(harnessDir, instanceId));
      }
      return closePromise;
    },
  };
}

function assertRealRunDirectory(runDir: string): void {
  if (!isAbsolute(runDir)) {
    throw new Error(`checkpoint runDir must be absolute: ${runDir}`);
  }
  const runStats = lstatSync(runDir);
  if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
    throw new Error(`checkpoint runDir must be a real directory: ${runDir}`);
  }
}

function existingHarnessDirectory(runDir: string): string {
  const harnessDir = join(runDir, HARNESS_DIR);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(harnessDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`checkpoint harness directory does not exist: ${harnessDir}`);
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${harnessDir} must be a real directory`);
  }
  const mode = stats.mode & 0o777;
  if (mode !== HARNESS_DIR_MODE) {
    throw new Error(
      `${harnessDir} has mode 0${mode.toString(8)}, expected 0${HARNESS_DIR_MODE.toString(8)}`,
    );
  }
  return harnessDir;
}

function ensureHarnessDirectory(runDir: string): string {
  const harnessDir = join(runDir, HARNESS_DIR);
  try {
    const stats = lstatSync(harnessDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${harnessDir} must be a real directory`);
    }
    const mode = stats.mode & 0o777;
    if (mode !== HARNESS_DIR_MODE) {
      throw new Error(
        `${harnessDir} has mode 0${mode.toString(8)}, expected 0${HARNESS_DIR_MODE.toString(8)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(harnessDir, { mode: HARNESS_DIR_MODE });
    chmodSync(harnessDir, HARNESS_DIR_MODE);
  }
  return harnessDir;
}

function lockPath(harnessDir: string): string {
  return join(harnessDir, RUN_LOCK_FILENAME);
}

function recoveryLockPath(harnessDir: string): string {
  return join(harnessDir, RUN_LOCK_RECOVERY_FILENAME);
}

function acquireRunLock(
  harnessDir: string,
  instanceId: string,
  now: () => number,
  beforeStaleLockUnlink?: () => void,
): void {
  const path = lockPath(harnessDir);
  const lock: RunLockFile = {
    harnessInstanceId: instanceId,
    processId: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  const serialized = `${JSON.stringify(lock, null, 2)}\n`;

  const tryCreate = (): boolean => {
    try {
      writeFileDurablyAtomic(path, serialized, {
        mode: 'create',
        fileMode: HARNESS_FILE_MODE,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  if (tryCreate()) return;
  const existing = readRunLock(path);
  if (existing !== undefined && processIsLive(existing.processId)) {
    throw new Error(
      `run is already open: lock held by pid ${existing.processId} ` +
        `(instance ${existing.harnessInstanceId})`,
    );
  }

  const recoveryPath = recoveryLockPath(harnessDir);
  const recoveryLock: RunLockFile = {
    harnessInstanceId: instanceId,
    processId: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  try {
    writeFileDurablyAtomic(recoveryPath, `${JSON.stringify(recoveryLock, null, 2)}\n`, {
      mode: 'create',
      fileMode: HARNESS_FILE_MODE,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`another process is already recovering the stale run lock at ${path}`);
    }
    throw error;
  }

  let acquired = false;
  try {
    // Re-read under the recovery guard. A lock that changed since the first
    // observation may belong to a new live contender and must never be
    // removed merely because the prior inode was stale.
    const current = readRunLock(path);
    if (canonicalJson(current) !== canonicalJson(existing)) {
      throw new Error(
        `run lock at ${path} changed during stale-lock recovery; refusing to remove it`,
      );
    }
    if (current !== undefined && processIsLive(current.processId)) {
      throw new Error(
        `run is already open: lock held by pid ${current.processId} ` +
          `(instance ${current.harnessInstanceId})`,
      );
    }

    beforeStaleLockUnlink?.();
    if (current !== undefined) unlinkSync(path);
    acquired = tryCreate();
    if (!acquired) {
      throw new Error(`another process claimed ${path} during stale-lock recovery`);
    }
  } finally {
    try {
      releaseRecoveryLock(harnessDir, instanceId);
    } catch (error) {
      // Do not return a store while its recovery guard could strand every
      // future opener. Relinquish the just-created run lock when possible and
      // surface the cleanup failure.
      if (acquired) {
        try {
          releaseRunLock(harnessDir, instanceId);
        } catch {
          // The recovery-lock failure remains the primary invariant breach.
        }
      }
      throw error;
    }
  }
}

function assertRunLockOwner(harnessDir: string, instanceId: string): void {
  let current: RunLockFile | undefined;
  try {
    current = readRunLock(lockPath(harnessDir));
  } catch (error) {
    throw new LockOwnershipError(
      `could not validate the run lock in ${harnessDir}: ${errorMessage(error)}`,
    );
  }
  if (current?.harnessInstanceId !== instanceId) {
    throw new LockOwnershipError(
      `run lock in ${harnessDir} is missing or owned by another instance`,
    );
  }
}

function releaseRunLock(harnessDir: string, instanceId: string): void {
  const path = lockPath(harnessDir);
  const current = readRunLock(path);
  if (current === undefined) {
    throw new LockOwnershipError(
      `run lock in ${harnessDir} disappeared before it could be released`,
    );
  }
  // A reassigned lock is not ours to remove. The save path already poisons
  // this store when ownership changes; close must preserve the new owner.
  if (current.harnessInstanceId !== instanceId) return;
  unlinkSync(path);
}

function releaseRecoveryLock(harnessDir: string, instanceId: string): void {
  const path = recoveryLockPath(harnessDir);
  const current = readRunLock(path);
  if (current?.harnessInstanceId !== instanceId) {
    throw new LockOwnershipError(
      `stale-lock recovery guard in ${harnessDir} is missing or owned by another instance`,
    );
  }
  unlinkSync(path);
}

function readRunLock(path: string): RunLockFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsedJson = parseJson(raw, `run lock at ${path}`);
  const parsed = runLockFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`run lock at ${path} failed validation:\n${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function readCheckpointFile(path: string): Checkpoint | undefined {
  const raw = readCheckpointText(path);
  if (raw === undefined) return undefined;
  const parsedJson = parseJson(raw, `checkpoint at ${path}`);
  const parsed = checkpointSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `checkpoint at ${path} failed schema validation; refusing to start fresh:\n` +
        formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}

function readCheckpointText(path: string): string | undefined {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`checkpoint at ${path} must be a regular file; symlinks are not followed`);
  }

  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`checkpoint at ${path} must be a regular file`);
    }
    const mode = opened.mode & 0o777;
    if (mode !== HARNESS_FILE_MODE) {
      throw new Error(
        `checkpoint at ${path} has mode 0${mode.toString(8)}, ` +
          `expected 0${HARNESS_FILE_MODE.toString(8)}`,
      );
    }
    if (opened.size > CHECKPOINT_MAX_BYTES) {
      throw checkpointSizeLimitError(path, opened.size);
    }

    const bytes = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        total,
        Math.min(CHECKPOINT_READ_CHUNK_BYTES, bytes.byteLength - total),
        null,
      );
      if (count === 0) break;
      total += count;
    }

    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = readSync(descriptor, overflowProbe, 0, 1, null);
    const after = fstatSync(descriptor);
    if (after.size > CHECKPOINT_MAX_BYTES) {
      throw checkpointSizeLimitError(path, Math.max(after.size, total + overflow));
    }
    if (overflow !== 0 || total !== opened.size || after.size !== opened.size) {
      throw new Error(`checkpoint at ${path} changed while it was being read`);
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function checkpointSizeLimitError(path: string, observedBytes: number): Error {
  return new Error(
    `checkpoint at ${path} is ${observedBytes} bytes, exceeding the ` +
      `${CHECKPOINT_MAX_BYTES}-byte read limit`,
  );
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

class LockOwnershipError extends Error {}

function isLockOwnershipError(error: unknown): boolean {
  return error instanceof LockOwnershipError;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
      return `- at ${path}: ${issue.message}`;
    })
    .join('\n');
}
