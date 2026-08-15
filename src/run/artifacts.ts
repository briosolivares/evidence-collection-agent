import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { BrowserProviderKind } from '../browser/sessionProvider.js';
import { commitArtifactWriteTransaction } from './artifactWriteTransaction.js';
import { writeFileDurablyAtomic } from './atomicFile.js';
import { resolveRunPath } from './runDir.js';

export {
  ARTIFACT_WRITE_JOURNAL_PATH,
  recoverPendingArtifactWrites,
  type ArtifactWriteRecoveryResult,
} from './artifactWriteTransaction.js';

/** Name of the manifest file inside every run directory. */
export const MANIFEST_FILENAME = 'manifest.json';

/** Run-dir subdirectory holding everything the agent publishes. */
export const ARTIFACTS_DIR = 'artifacts';

/** Run-dir subdirectory holding private agent working state — never graded
 * or shown, though still hashed into the manifest (tamper evidence is
 * total). */
export const SCRATCH_DIR = 'scratch';

/**
 * Semantic role of a published artifact: the task explicitly asked for the
 * file (`requested_output`), or it is a supporting/audit capture backing the
 * outputs (`evidence`). One artifact may hold both roles — e.g. an
 * explicitly requested screenshot that also serves as audit evidence.
 */
export type ArtifactRole = 'requested_output' | 'evidence';

/** Provenance record for one artifact in the run directory. */
export interface ManifestEntry {
  /** Run-dir-relative path of the artifact file. */
  filename: string;
  /** Lowercase hex SHA-256 of the artifact's exact bytes at capture time. */
  sha256: string;
  /** URL the artifact was captured from, when one applies. */
  sourceUrl?: string;
  /** Semantic roles of a published artifact. Present exactly when the file
   * lives under artifacts/ — scratch entries carry no roles, so the field's
   * presence is itself the published/private marker. */
  roles?: ArtifactRole[];
  /** ISO 8601 timestamp of when the artifact was written. */
  capturedAt: string;
  /** Whether this artifact fully satisfies what the contract asked of it.
   * Absent means "not tracked" — the historical shape, and what every
   * legacy run directory carries, so existing readers keep working.
   * `partial` is written only by incomplete-run finalization, and only for
   * outputs whose contract requirement is unmet: an already-satisfied
   * screenshot or download stays `complete`. Graders and humans can then
   * see at a glance which deliverables to trust. */
  completionStatus?: 'complete' | 'partial';
}

/** The run's provenance index, stored as <runDir>/manifest.json. */
export interface Manifest {
  /** The task text the run was started with. */
  task: string;
  /** ISO 8601 timestamp of when the run started. */
  startedAt: string;
  /** ISO 8601 timestamp of when the run ended; absent until finalized. */
  finishedAt?: string;
  /**
   * Which browser runtime produced this run. Absent for runs with no browser
   * (and for runs recorded before this field existed).
   *
   * Recorded because the runtime changes both what a run CAN do and how long
   * it takes — a Google-authenticated step is reachable on Browserbase and
   * impossible on local Chrome, and remote turns measured roughly twice the
   * wall time — yet nothing in a finished run said which one it was. That had
   * to be inferred from timestamps against a commit date, which is not
   * provenance.
   *
   * Only the provider NAME. The rest of BrowserSessionDiagnostics stays out:
   * liveViewUrl and recordingUrl are local-user-interface only, and this file
   * is readable by the verifier.
   */
  browserProvider?: BrowserProviderKind;
  /** One entry per distinct artifact path, most recent write wins. */
  artifacts: ManifestEntry[];
}

/** Optional provenance metadata accompanying an artifact write. */
export interface ArtifactMeta {
  /** URL the artifact was captured from, recorded in its manifest entry. */
  sourceUrl?: string;
  /** Semantic roles for a published (artifacts/) write, recorded in its
   * manifest entry. Scratch writes carry none. */
  roles?: ArtifactRole[];
  /** Whether the write fully satisfies its contract requirement (see
   * ManifestEntry.completionStatus). Omit unless the caller genuinely
   * knows; absent is the honest default. */
  completionStatus?: 'complete' | 'partial';
}

/**
 * Create the run's manifest, recording the task text and start time.
 *
 * @param runDir - absolute path to an existing run directory that does not
 *   yet contain a manifest; throws if one already exists (double-init is a
 *   bug, and overwriting would erase recorded provenance)
 * @param taskText - the task the run was started with, recorded verbatim
 * @param browserProvider - the runtime hosting this run's browser; omit for a
 *   run that has none
 * @returns nothing; <runDir>/manifest.json now holds valid JSON with the
 *   task text, a start timestamp, and an empty artifact list, and the
 *   artifacts/ and scratch/ subdirectories exist — the workspace layout is
 *   in place before the loop's first turn, like the manifest itself
 */
export function initManifest(
  runDir: string,
  taskText: string,
  browserProvider?: BrowserProviderKind,
): void {
  const manifest: Manifest = {
    task: taskText,
    startedAt: new Date().toISOString(),
    ...(browserProvider === undefined ? {} : { browserProvider }),
    artifacts: [],
  };
  // Exclusive durable creation keeps the double-init guard while ensuring a
  // crash can expose only the complete manifest or no manifest at all.
  writeFileDurablyAtomic(manifestPath(runDir), serializeManifest(manifest), {
    mode: 'create',
  });
  mkdirSync(join(runDir, ARTIFACTS_DIR), { recursive: true });
  mkdirSync(join(runDir, SCRATCH_DIR), { recursive: true });
}

/**
 * Read the run's manifest as it stands on disk, without mutating it.
 *
 * At least three ad hoc manifest readers already exist elsewhere in the
 * codebase (`src/completion/completionCheck.ts` and
 * `src/completion/finalizeIncompleteRun.ts`), each re-implementing "read
 * manifest.json, JSON.parse it, throw if that fails" inline. Consolidating
 * them onto this function is deliberately out of scope here — this only
 * keeps the count from growing for callers written from now on.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; throws if the manifest file is missing or is not valid JSON
 * @returns the manifest exactly as stored, unmodified
 */
export function readManifest(runDir: string): Manifest {
  return loadManifest(runDir);
}

/**
 * Write an artifact file into the run directory and record its provenance
 * in the manifest. This is the single write path every file-producing tool
 * routes through, so provenance can never be forgotten. A durable private
 * intent is recorded before an atomic file replacement; recovery can finish
 * the manifest upsert after a crash without accepting different bytes.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; throws (writing nothing) if the manifest is missing
 * @param relPath - relative path for the artifact, confined to the run
 *   directory (see resolveRunPath) and required to land under artifacts/
 *   (published — non-empty roles required) or scratch/ (private — roles
 *   forbidden); throws (writing nothing) if it escapes or breaks the
 *   partition. Missing parent directories are created
 * @param bytes - the artifact's content, written to disk exactly as given
 * @param meta - optional provenance; a given sourceUrl and given roles are
 *   recorded in the artifact's manifest entry
 * @returns the manifest entry now on record for this artifact: its
 *   normalized run-dir-relative filename, the SHA-256 of the exact bytes
 *   written, the sourceUrl if given, and the capture timestamp. The
 *   manifest holds exactly one entry per distinct path — writing the same
 *   path again replaces its entry rather than adding a second
 */
export function writeArtifact(
  runDir: string,
  relPath: string,
  bytes: Uint8Array,
  meta: ArtifactMeta = {},
): ManifestEntry {
  const absPath = resolveRunPath(runDir, relPath);
  // Normalizing through the resolved path makes equivalent spellings
  // ("artifacts/data.csv", "./artifacts/data.csv") collide onto one
  // manifest entry.
  const filename = relative(resolve(runDir), absPath);
  assertWorkspacePartition(filename, relPath, meta);

  const entry: ManifestEntry = {
    filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(meta.sourceUrl !== undefined ? { sourceUrl: meta.sourceUrl } : {}),
    ...(meta.roles !== undefined ? { roles: meta.roles } : {}),
    capturedAt: new Date().toISOString(),
    ...(meta.completionStatus !== undefined
      ? { completionStatus: meta.completionStatus }
      : {}),
  };
  commitArtifactWriteTransaction(runDir, entry, bytes);
  return entry;
}

/**
 * Stamp the run's end time into the manifest.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; throws if the manifest is missing
 * @returns nothing; the manifest's finishedAt now holds the current time,
 *   with every other field left untouched
 */
export function finalizeManifest(runDir: string): void {
  const manifest = loadManifest(runDir);
  manifest.finishedAt = new Date().toISOString();
  writeManifestDurably(runDir, manifest);
}

/**
 * Enforce the workspace partition at the single write path: every artifact
 * lives under artifacts/ (published — must carry at least one role) or
 * scratch/ (private — must carry none). The roles field's presence is the
 * published/private marker, so it can never contradict the file's location.
 */
function assertWorkspacePartition(
  filename: string,
  relPath: string,
  meta: ArtifactMeta,
): void {
  const published = filename.startsWith(`${ARTIFACTS_DIR}${sep}`);
  const scratch = filename.startsWith(`${SCRATCH_DIR}${sep}`);
  if (!published && !scratch) {
    throw new Error(
      `artifact path must be under ${ARTIFACTS_DIR}/ (published) or ` +
        `${SCRATCH_DIR}/ (private working files): ${JSON.stringify(relPath)}`,
    );
  }
  if (published && (meta.roles === undefined || meta.roles.length === 0)) {
    throw new Error(
      `published artifacts must carry at least one role ` +
        `(requested_output and/or evidence): ${JSON.stringify(relPath)}`,
    );
  }
  if (scratch && meta.roles !== undefined) {
    throw new Error(
      `scratch files are private and carry no roles: ${JSON.stringify(relPath)}`,
    );
  }
}

function manifestPath(runDir: string): string {
  return join(runDir, MANIFEST_FILENAME);
}

function writeManifestDurably(runDir: string, manifest: Manifest): void {
  writeFileDurablyAtomic(manifestPath(runDir), serializeManifest(manifest));
}

function loadManifest(runDir: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath(runDir), 'utf8');
  } catch {
    throw new Error(`no manifest in ${runDir} — call initManifest at run start`);
  }
  return JSON.parse(raw) as Manifest;
}

function serializeManifest(manifest: Manifest): string {
  // Pretty-printed: the manifest is read by humans (auditors) as well as
  // graders.
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Mark one already-written artifact `complete` or `partial` without
 * rewriting its bytes (see ManifestEntry.completionStatus).
 *
 * Used by incomplete-run finalization: the run is ending unverified, and the
 * outputs whose contract requirement is unmet must say so, while the ones
 * already satisfied keep standing. Rewriting the file to record this would
 * change its hash and destroy the provenance the manifest exists to keep, so
 * only the entry is touched.
 *
 * @param runDir - absolute path to a run directory with an initialized manifest
 * @param relPath - run-dir-relative path of an artifact already on record
 * @param status - the status to record
 * @returns the updated entry
 * @throws if the manifest has no entry for that path — marking a file the
 *   run never wrote would be a bookkeeping lie, not a recoverable slip
 */
export function setArtifactCompletionStatus(
  runDir: string,
  relPath: string,
  status: 'complete' | 'partial',
): ManifestEntry {
  const filename = relative(resolve(runDir), resolveRunPath(runDir, relPath));
  const manifest = loadManifest(runDir);
  const index = manifest.artifacts.findIndex((a) => a.filename === filename);
  if (index < 0) {
    throw new Error(
      `cannot set completion status: ${filename} has no manifest entry in ${runDir}`,
    );
  }
  const updated: ManifestEntry = { ...manifest.artifacts[index]!, completionStatus: status };
  manifest.artifacts[index] = updated;
  writeManifestDurably(runDir, manifest);
  return updated;
}

/**
 * Drop one scratch file's manifest entry after the caller has already
 * observed the file itself is gone from disk.
 *
 * This is bookkeeping only — deliberately no filesystem access here. The
 * intended caller (a post-command reconciliation pass over scratch/workspace)
 * has already established absence by walking the directory; touching the
 * filesystem again here would just be a second, redundant source of truth to
 * keep in sync with the first.
 *
 * @param runDir - absolute path to a run directory with an initialized
 *   manifest; throws if the manifest is missing
 * @param relPath - run-dir-relative path of the scratch entry to drop; must
 *   resolve under scratch/ — throws for an artifacts/ path (published
 *   provenance is never silently dropped this way) or a path that escapes
 *   the run directory
 * @returns nothing; every other entry is preserved untouched, and the
 *   manifest is rewritten through the same serialization helper every other
 *   write uses. A path with no matching manifest entry is a no-op — nothing
 *   is written — which is what makes repeating a reconciliation pass over
 *   the same removal harmless
 */
export function removeScratchArtifactEntry(runDir: string, relPath: string): void {
  const filename = relative(resolve(runDir), resolveRunPath(runDir, relPath));
  if (!filename.startsWith(`${SCRATCH_DIR}${sep}`)) {
    throw new Error(
      `removeScratchArtifactEntry only removes ${SCRATCH_DIR}/ entries, never published ` +
        `provenance: ${JSON.stringify(relPath)}`,
    );
  }

  const manifest = loadManifest(runDir);
  const remaining = manifest.artifacts.filter((entry) => entry.filename !== filename);
  if (remaining.length === manifest.artifacts.length) return; // already absent: no-op
  manifest.artifacts = remaining;
  writeManifestDurably(runDir, manifest);
}

/**
 * Recovery-time integrity check: every manifest entry must resolve inside
 * the run directory, exist as a regular, non-symlink file, and match its
 * recorded SHA-256.
 *
 * Hash verification of manifest entries already exists as
 * `validateManifestIntegrity` in `src/completion/completionCheck.ts`, and
 * this function deliberately does not become a third implementation of that
 * comparison — but it cannot delegate to it either. That module imports
 * `ARTIFACTS_DIR`, `writeArtifact`, and other names from this one, so an
 * import the other way would be a cycle. More importantly, delegating would
 * silently drop the guarantee this function exists to add:
 * `validateManifestIntegrity` reads entries with `existsSync`/`readFileSync`,
 * which both follow symlinks, so a symlink planted where a manifest entry
 * expects a plain file would be "verified" against bytes that live somewhere
 * else on disk entirely. That gap is tolerable on the ordinary
 * submission-time path it serves, but recovery runs over a run directory a
 * crashed or untrusted worker left behind, where a planted symlink is
 * exactly the kind of thing recovery needs to catch rather than trust.
 *
 * @param runDir - absolute path to the run directory being recovered
 * @throws one Error listing every failing entry — a path that escapes the
 *   run directory, a missing file, a non-regular file (symlink, socket,
 *   FIFO, device), or a hash mismatch — collected in one pass so recovery
 *   sees the whole picture instead of stopping at the first problem;
 *   returns normally only when every entry matches
 */
export function verifyManifestFiles(runDir: string): void {
  const manifest = loadManifest(runDir);
  const problems: string[] = [];

  for (const entry of manifest.artifacts) {
    let absPath: string;
    try {
      absPath = resolveRunPath(runDir, entry.filename);
    } catch {
      problems.push(`${entry.filename}: does not resolve inside the run directory`);
      continue;
    }

    // O_NOFOLLOW refuses to open a path that is itself a symlink at all
    // (the open fails with ELOOP) rather than silently opening whatever it
    // points to. O_NONBLOCK keeps a FIFO from hanging this pass forever
    // waiting for a writer that will never come; it has no effect on the
    // regular-file read below once fstat has confirmed the type. Both flags
    // are undefined on platforms that lack them (Windows), where the fstat
    // check below is the only remaining defense.
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    let fd: number;
    try {
      fd = openSync(absPath, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        problems.push(`${entry.filename}: recorded in the manifest but no longer exists`);
      } else if (code === 'ELOOP') {
        problems.push(`${entry.filename}: is a symlink, not a regular file`);
      } else {
        problems.push(
          `${entry.filename}: could not be opened (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
      continue;
    }

    try {
      if (!fstatSync(fd).isFile()) {
        problems.push(`${entry.filename}: is not a regular file`);
        continue;
      }
      const actual = createHash('sha256').update(readFileSync(fd)).digest('hex');
      if (actual !== entry.sha256) {
        problems.push(
          `${entry.filename}: changed after it was recorded (manifest hash ` +
            `${entry.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`,
        );
      }
    } finally {
      closeSync(fd);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `manifest verification failed for ${problems.length} of ${manifest.artifacts.length} ` +
        `entr${problems.length === 1 ? 'y' : 'ies'} in ${runDir}:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
}
