import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { Manifest, ManifestEntry } from './artifacts.js';
import { writeFileDurablyAtomic } from './atomicFile.js';
import { resolveRunPath } from './runDir.js';

const MANIFEST_FILENAME = 'manifest.json';
const HARNESS_DIR = 'harness';
const JOURNAL_DIR = 'artifact-write-journal';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_CHUNK_BYTES = 64 * 1024;

/** Recovery refuses provenance larger than finish inspection accepts. */
export const ARTIFACT_WRITE_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** One intent contains only bounded path/provenance metadata, never payload bytes. */
export const ARTIFACT_WRITE_MAX_JOURNAL_BYTES = 64 * 1024;

/** Runtime-private location of pending artifact/manifest write intents. */
export const ARTIFACT_WRITE_JOURNAL_PATH = `${HARNESS_DIR}/${JOURNAL_DIR}`;

const manifestEntrySchema = z.strictObject({
  filename: z.string().min(1),
  sha256: z.string().regex(SHA256_PATTERN),
  sourceUrl: z.string().optional(),
  roles: z
    .array(z.enum(['requested_output', 'evidence']))
    .min(1)
    .optional(),
  capturedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be an ISO-compatible timestamp',
  }),
  completionStatus: z.enum(['complete', 'partial']).optional(),
});

const artifactWriteJournalSchema = z.strictObject({
  version: z.literal(1),
  owner: z.strictObject({
    transactionId: z.string().regex(UUID_PATTERN),
    processId: z.number().int().nonnegative(),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'must be an ISO-compatible timestamp',
    }),
  }),
  target: z.strictObject({
    filename: z.string().min(1),
    stagingFilename: z.string().min(1),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(SHA256_PATTERN),
  }),
  entry: manifestEntrySchema,
});

type ArtifactWriteJournal = z.infer<typeof artifactWriteJournalSchema>;

/** Crash-boundary hooks used by the real-process durability tests. */
export interface ArtifactWriteTransactionHooks {
  afterJournalPersisted?: (journalPath: string) => void;
  afterArtifactTempFileSync?: (tempPath: string) => void;
  afterArtifactCommitted?: (targetPath: string) => void;
  afterManifestCommitted?: () => void;
}

export interface ArtifactWriteRecoveryResult {
  /** Intents whose exact target bytes were committed to the manifest. */
  recoveredEntries: number;
  /** Intents whose target was absent or did not match; the manifest stayed unchanged. */
  discardedIntents: number;
  /** Transaction-owned artifact staging files removed. */
  removedArtifactTemps: number;
  /** Unpublished journal staging files removed from the private journal directory. */
  removedJournalTemps: number;
}

export interface ArtifactWriteRecoveryOptions {
  /** Trusted cancellation/deadline guard. A thrown error propagates unchanged. */
  checkActive?: () => void;
}

/**
 * Commit one already-validated artifact entry and its exact bytes as a
 * recoverable file+manifest transaction.
 *
 * This is exported only so the crash fixture can stop the real process at
 * precise boundaries. Production callers use `writeArtifact`, which owns
 * path/role validation and entry construction.
 */
export function commitArtifactWriteTransaction(
  runDir: string,
  entry: ManifestEntry,
  bytes: Uint8Array,
  hooks: ArtifactWriteTransactionHooks = {},
): void {
  assertRunRoot(runDir);
  const intended = parseAndValidateEntry(runDir, entry);
  const content = Buffer.from(bytes);
  const actualHash = sha256(content);
  if (actualHash !== intended.sha256) {
    throw new Error(
      `artifact transaction bytes do not match intended SHA-256 for ${intended.filename}`,
    );
  }

  // Requiring the manifest before any durable intent preserves the original
  // writeArtifact guarantee: a run that was never initialized gets no file.
  loadManifestNoFollow(runDir);

  const targetPath = resolveRunPath(runDir, intended.filename);
  ensureArtifactParentDirectories(runDir, targetPath);
  assertRegularFileOrAbsent(targetPath, intended.filename);

  const journalDir = ensureJournalDirectory(runDir);
  const transactionId = randomUUID();
  const artifactTempFileId = `artifact-${transactionId}`;
  const stagingFilename = atomicTempFilename(targetPath, artifactTempFileId);
  const journal: ArtifactWriteJournal = {
    version: 1,
    owner: {
      transactionId,
      processId: process.pid,
      startedAt: new Date().toISOString(),
    },
    target: {
      filename: intended.filename,
      stagingFilename,
      byteLength: content.byteLength,
      sha256: intended.sha256,
    },
    entry: intended,
  };
  const journalPath = join(journalDir, `${transactionId}.json`);

  let journalPersisted = false;
  let artifactCommitted = false;
  let manifestCommitted = false;
  try {
    writeFileDurablyAtomic(journalPath, serialize(journal), {
      mode: 'create',
      fileMode: PRIVATE_FILE_MODE,
    });
    journalPersisted = true;
    hooks.afterJournalPersisted?.(journalPath);
    writeFileDurablyAtomic(targetPath, content, {
      tempFileId: artifactTempFileId,
      ...(hooks.afterArtifactTempFileSync === undefined
        ? {}
        : { afterTempFileSync: hooks.afterArtifactTempFileSync }),
    });
    artifactCommitted = true;
    hooks.afterArtifactCommitted?.(targetPath);

    upsertManifestEntry(runDir, intended);
    manifestCommitted = true;
    hooks.afterManifestCommitted?.();

    removeTransactionFiles(runDir, journalDir, journal);
  } catch (error) {
    // Ordinary failures before publication are fully reversible: the atomic
    // writer has retained the old target (or absence), so discard the intent.
    // Once new bytes are visible, retain the journal until recovery can pair
    // them with the manifest. If the manifest did commit, cleanup is safe to
    // retry here and later remains idempotent.
    const journalCreateCollision =
      !journalPersisted && (error as NodeJS.ErrnoException).code === 'EEXIST';
    if ((!artifactCommitted || manifestCommitted) && !journalCreateCollision) {
      try {
        removeTransactionFiles(runDir, journalDir, journal);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `artifact transaction failed and its private journal cleanup also failed`,
        );
      }
    }
    throw error;
  }
}

/**
 * Recover every durable artifact-write intent under `harness/`.
 *
 * An intent is completed only when a no-follow read proves the current target
 * is a regular file with the exact recorded byte length and SHA-256. Missing
 * or different targets never change the manifest. In either case, only the
 * transaction's own staging name and journal are removed. Repeating this
 * function after a crash at any recovery boundary is safe.
 */
export function recoverPendingArtifactWrites(
  runDir: string,
  options: ArtifactWriteRecoveryOptions = {},
): ArtifactWriteRecoveryResult {
  options.checkActive?.();
  assertRunRoot(runDir);
  // Refuse to consume or delete runtime state unless the run itself still has
  // a readable regular manifest.
  loadManifestNoFollow(runDir, options.checkActive);

  const result: ArtifactWriteRecoveryResult = {
    recoveredEntries: 0,
    discardedIntents: 0,
    removedArtifactTemps: 0,
    removedJournalTemps: 0,
  };
  const journalDir = findJournalDirectory(runDir);
  if (journalDir === undefined) return result;

  const journals: Array<{ path: string; value: ArtifactWriteJournal }> = [];
  const directory = opendirSync(journalDir);
  try {
    for (;;) {
      options.checkActive?.();
      const dirent = directory.readSync();
      if (dirent === null) break;
      const path = join(journalDir, dirent.name);
      if (isJournalAtomicTempName(dirent.name)) {
        unlinkDurably(path, journalDir);
        result.removedJournalTemps += 1;
        continue;
      }
      if (!dirent.name.endsWith('.json')) continue;
      if (!dirent.isFile() || dirent.isSymbolicLink()) {
        throw new Error(`${path} must be a regular, non-symlink journal file`);
      }
      const value = readJournal(path, options.checkActive);
      if (dirent.name !== `${value.owner.transactionId}.json`) {
        throw new Error(`${path} does not match its artifact transaction owner`);
      }
      validateJournal(runDir, value);
      journals.push({ path, value });
    }
  } finally {
    directory.closeSync();
  }

  // Multiple distinct writes may be pending. Stable oldest-to-newest replay
  // also gives deterministic last-intent-wins behavior if a caller violated
  // the scheduler and produced multiple intents for one target.
  journals.sort((left, right) => {
    const byTime = left.value.owner.startedAt.localeCompare(right.value.owner.startedAt);
    return byTime !== 0
      ? byTime
      : left.value.owner.transactionId.localeCompare(right.value.owner.transactionId);
  });

  for (const pending of journals) {
    options.checkActive?.();
    const { value } = pending;
    const targetPath = resolveRunPath(runDir, value.target.filename);
    const parentIsSafe = artifactParentsAreReal(runDir, targetPath);
    const matches =
      parentIsSafe &&
      targetMatchesIntent(
        targetPath,
        value.target.byteLength,
        value.target.sha256,
        options.checkActive,
      );

    options.checkActive?.();

    if (matches) {
      upsertManifestEntry(runDir, value.entry as ManifestEntry, options.checkActive);
      result.recoveredEntries += 1;
    } else {
      result.discardedIntents += 1;
    }

    if (parentIsSafe) {
      const tempPath = join(dirname(targetPath), value.target.stagingFilename);
      if (unlinkDurablyIfPresent(tempPath, dirname(targetPath))) {
        result.removedArtifactTemps += 1;
      }
    }
    unlinkDurably(pending.path, journalDir);
  }

  return result;
}

function parseAndValidateEntry(runDir: string, entry: ManifestEntry): ManifestEntry {
  const parsed = manifestEntrySchema.parse(entry) as ManifestEntry;
  const targetPath = resolveRunPath(runDir, parsed.filename);
  const normalized = relative(resolve(runDir), targetPath);
  if (normalized !== parsed.filename) {
    throw new Error(
      `artifact transaction filename must already be normalized: ${JSON.stringify(parsed.filename)}`,
    );
  }
  assertEntryPartition(parsed);
  return parsed;
}

function validateJournal(runDir: string, journal: ArtifactWriteJournal): void {
  const entry = parseAndValidateEntry(runDir, journal.entry as ManifestEntry);
  if (journal.target.filename !== entry.filename || journal.target.sha256 !== entry.sha256) {
    throw new Error(
      `artifact transaction ${journal.owner.transactionId} target disagrees with its manifest entry`,
    );
  }
  const targetPath = resolveRunPath(runDir, journal.target.filename);
  const expectedStaging = atomicTempFilename(targetPath, `artifact-${journal.owner.transactionId}`);
  if (journal.target.stagingFilename !== expectedStaging) {
    throw new Error(
      `artifact transaction ${journal.owner.transactionId} has an invalid staging filename`,
    );
  }
}

function assertEntryPartition(entry: ManifestEntry): void {
  const published = entry.filename.startsWith(`artifacts${sep}`);
  const scratch = entry.filename.startsWith(`scratch${sep}`);
  if (!published && !scratch) {
    throw new Error(`artifact transaction target is outside artifacts/ and scratch/`);
  }
  if (published && (entry.roles === undefined || entry.roles.length === 0)) {
    throw new Error(`published artifact transaction entry has no role`);
  }
  if (scratch && entry.roles !== undefined) {
    throw new Error(`scratch artifact transaction entry must not carry roles`);
  }
}

function upsertManifestEntry(runDir: string, entry: ManifestEntry, checkActive?: () => void): void {
  const manifest = loadManifestNoFollow(runDir, checkActive);
  const index = manifest.artifacts.findIndex((candidate) => candidate.filename === entry.filename);
  if (index >= 0) manifest.artifacts[index] = entry;
  else manifest.artifacts.push(entry);
  writeFileDurablyAtomic(join(resolve(runDir), MANIFEST_FILENAME), serialize(manifest));
}

function loadManifestNoFollow(runDir: string, checkActive?: () => void): Manifest {
  const path = join(resolve(runDir), MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = readRegularFileNoFollow(path, ARTIFACT_WRITE_MAX_MANIFEST_BYTES, checkActive).toString(
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no manifest in ${runDir} — call initManifest at run start`);
    }
    throw error;
  }
  const value = JSON.parse(raw) as Partial<Manifest>;
  if (!Array.isArray(value.artifacts)) {
    throw new Error(`manifest in ${runDir} has no artifact array`);
  }
  return value as Manifest;
}

function ensureJournalDirectory(runDir: string): string {
  const harnessDir = join(resolve(runDir), HARNESS_DIR);
  ensurePrivateDirectory(harnessDir);
  const journalDir = join(harnessDir, JOURNAL_DIR);
  ensurePrivateDirectory(journalDir);
  return journalDir;
}

function findJournalDirectory(runDir: string): string | undefined {
  const harnessDir = join(resolve(runDir), HARNESS_DIR);
  if (!pathExistsNoFollow(harnessDir)) return undefined;
  assertPrivateDirectory(harnessDir);
  const journalDir = join(harnessDir, JOURNAL_DIR);
  if (!pathExistsNoFollow(journalDir)) return undefined;
  assertPrivateDirectory(journalDir);
  return journalDir;
}

function ensurePrivateDirectory(path: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE });
    created = true;
    chmodSync(path, PRIVATE_DIR_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateDirectory(path);
  if (created) fsyncDirectoryBestEffort(dirname(path));
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a real private directory`);
  }
  const mode = stat.mode & 0o777;
  if (mode !== PRIVATE_DIR_MODE) {
    throw new Error(
      `${path} has mode 0${mode.toString(8)}, expected 0${PRIVATE_DIR_MODE.toString(8)}`,
    );
  }
}

function assertRunRoot(runDir: string): void {
  const root = resolve(runDir);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${root} must be a real run directory`);
  }
}

function ensureArtifactParentDirectories(runDir: string, targetPath: string): void {
  const root = resolve(runDir);
  const relParent = relative(root, dirname(targetPath));
  let current = root;
  for (const segment of relParent.split(sep).filter((value) => value !== '')) {
    current = join(current, segment);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    assertRealDirectory(current);
  }
}

function artifactParentsAreReal(runDir: string, targetPath: string): boolean {
  const root = resolve(runDir);
  const relParent = relative(root, dirname(targetPath));
  let current = root;
  for (const segment of relParent.split(sep).filter((value) => value !== '')) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a real directory; symlinks are not followed`);
  }
}

function assertRegularFileOrAbsent(path: string, filename: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${filename} must be absent or a regular file; symlinks are not followed`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function targetMatchesIntent(
  path: string,
  byteLength: number,
  expectedHash: string,
  checkActive?: () => void,
): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The target may change between lstat and O_NOFOLLOW open. Treat absence
    // or a newly planted symlink as a non-match; never follow it.
    if (code === 'ENOENT' || code === 'ELOOP') return false;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== byteLength) return false;

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let observed = 0;
    for (;;) {
      checkActive?.();
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      observed += count;
      if (observed > byteLength) return false;
      hash.update(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    return (
      observed === byteLength &&
      after.isFile() &&
      after.size === byteLength &&
      hash.digest('hex') === expectedHash
    );
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFileNoFollow(
  path: string,
  maximumBytes: number,
  checkActive?: () => void,
): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file; symlinks are not followed`);
  }
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${path} must be a regular file`);
    }
    if (stat.size > maximumBytes) {
      throw fileSizeLimitError(path, stat.size, maximumBytes);
    }

    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      checkActive?.();
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) {
        throw fileSizeLimitError(path, total, maximumBytes);
      }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function readJournal(path: string, checkActive?: () => void): ArtifactWriteJournal {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a regular, non-symlink journal file`);
  }
  const mode = stat.mode & 0o777;
  if (mode !== PRIVATE_FILE_MODE) {
    throw new Error(
      `${path} has mode 0${mode.toString(8)}, expected 0${PRIVATE_FILE_MODE.toString(8)}`,
    );
  }
  const raw = readRegularFileNoFollow(path, ARTIFACT_WRITE_MAX_JOURNAL_BYTES, checkActive).toString(
    'utf8',
  );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = artifactWriteJournalSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${path} failed artifact journal validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function fileSizeLimitError(path: string, observedBytes: number, maximumBytes: number): Error {
  return new Error(
    `${path} is at least ${observedBytes} bytes, above the ` +
      `${maximumBytes}-byte artifact transaction recovery limit`,
  );
}

function removeTransactionFiles(
  runDir: string,
  journalDir: string,
  journal: ArtifactWriteJournal,
): void {
  const targetPath = resolveRunPath(runDir, journal.target.filename);
  if (artifactParentsAreReal(runDir, targetPath)) {
    unlinkDurablyIfPresent(
      join(dirname(targetPath), journal.target.stagingFilename),
      dirname(targetPath),
    );
  }
  unlinkDurablyIfPresent(join(journalDir, `${journal.owner.transactionId}.json`), journalDir);
}

function unlinkDurably(path: string, parentDir: string): void {
  unlinkSync(path);
  fsyncDirectoryBestEffort(parentDir);
}

function unlinkDurablyIfPresent(path: string, parentDir: string): boolean {
  try {
    unlinkDurably(path, parentDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Some platforms cannot fsync a directory descriptor. Publication and
    // cleanup remain atomic; only the strongest reboot durability is absent.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Same best-effort platform boundary as opening/fsyncing the dir.
      }
    }
  }
}

function pathExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function atomicTempFilename(targetPath: string, tempFileId: string): string {
  return `.${basename(targetPath)}.${tempFileId}.tmp`;
}

function isJournalAtomicTempName(name: string): boolean {
  return /^\.[0-9a-f-]{36}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
