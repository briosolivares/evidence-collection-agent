import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { BrowserProviderKind } from '../browser/sessionProvider.js';
import { commitArtifactWriteTransaction } from './artifactWriteTransaction.js';
import { writeFileDurablyAtomic } from './atomicFile.js';
import { NoFollowFileError, readFileNoFollow } from './noFollowFile.js';
import { resolveRunPath } from './runDir.js';

export {
  ARTIFACT_WRITE_JOURNAL_PATH,
  recoverPendingArtifactWrites,
  type ArtifactWriteRecoveryResult,
} from './artifactWriteTransaction.js';

/** Name of the manifest file inside every run directory. */
export const MANIFEST_FILENAME = 'manifest.json';
/** Shared runtime reads reject corrupt provenance before allocating without
 * bound; transaction and finish boundaries independently enforce this same
 * four-MiB scale under their stronger schemas. */
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

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

/** The trusted publication path that produced a published artifact. The
 * worker chooses a publish_artifact mode, but the runtime executes that mode
 * and records it only after acquiring the corresponding bytes. Keeping this
 * fact lets finish checks distinguish, for example, an SEC screenshot from
 * an SEC download without guessing from an overlapping filename or URL. */
export type ArtifactPublicationKind = 'file' | 'text' | 'screenshot' | 'download';

/** Provenance record for one artifact in the run directory. */
export interface ManifestEntry {
  /** Run-dir-relative path of the artifact file. */
  filename: string;
  /** Lowercase hex SHA-256 of the artifact's exact bytes at capture time. */
  sha256: string;
  /** URL the artifact was captured from, when one applies. */
  sourceUrl?: string;
  /** Runtime-executed publish_artifact mode. Optional for compatibility with
   * existing run directories and writes outside that model-facing boundary. */
  publicationKind?: ArtifactPublicationKind;
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
  /** Runtime-executed publication mode, when the caller owns that fact. */
  publicationKind?: ArtifactPublicationKind;
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
 * Runtime callers that need stronger shape, confinement, or hash guarantees
 * layer those checks on top of this raw provenance read.
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
  // Re-run destination policy immediately before constructing the durable
  // entry. publish_artifact also calls this before acquiring browser bytes;
  // this second check closes that potentially long check/write window.
  const filename = preflightArtifactWrite(runDir, relPath, meta.roles);
  if (meta.publicationKind !== undefined && !filename.startsWith(`${ARTIFACTS_DIR}${sep}`)) {
    throw new Error('publicationKind is valid only for published artifacts');
  }

  const entry: ManifestEntry = {
    filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(meta.sourceUrl !== undefined ? { sourceUrl: meta.sourceUrl } : {}),
    ...(meta.publicationKind !== undefined ? { publicationKind: meta.publicationKind } : {}),
    ...(meta.roles !== undefined ? { roles: meta.roles } : {}),
    capturedAt: new Date().toISOString(),
    ...(meta.completionStatus !== undefined ? { completionStatus: meta.completionStatus } : {}),
  };
  commitArtifactWriteTransaction(runDir, entry, bytes);
  return entry;
}

/** Resolve one artifact path and enforce the shared publication/write policy.
 * Published files may overwrite only a manifested entry with the same role
 * set; scratch reconciliation may adopt an existing ordinary file. */
export function preflightArtifactWrite(
  runDir: string,
  relPath: string,
  roles: readonly ArtifactRole[] | undefined,
): string {
  const absolutePath = resolveRunPath(runDir, relPath);
  // Normalizing through the resolved path makes equivalent spellings
  // ("artifacts/data.csv", "./artifacts/data.csv") collide onto one entry.
  const filename = relative(resolve(runDir), absolutePath);
  assertWorkspacePartition(filename, relPath, roles);

  const published = filename.startsWith(`${ARTIFACTS_DIR}${sep}`);
  const existingEntry = loadManifest(runDir).artifacts.find((entry) => entry.filename === filename);
  if (published && existingEntry !== undefined && !sameRoleSet(existingEntry.roles, roles)) {
    throw new Error(
      `cannot overwrite ${filename}: existing roles ${formatRoles(existingEntry.roles)} ` +
        `do not match requested roles ${formatRoles(roles)}`,
    );
  }

  const destinationState = inspectArtifactDestination(runDir, filename);
  if (published && destinationState === 'file' && existingEntry === undefined) {
    throw new Error(
      `cannot overwrite unmanifested file at ${filename}; choose another artifact_path`,
    );
  }
  return filename;
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
  roles: readonly ArtifactRole[] | undefined,
): void {
  const published = filename.startsWith(`${ARTIFACTS_DIR}${sep}`);
  const scratch = filename.startsWith(`${SCRATCH_DIR}${sep}`);
  if (!published && !scratch) {
    throw new Error(
      `artifact path must be under ${ARTIFACTS_DIR}/ (published) or ` +
        `${SCRATCH_DIR}/ (private working files): ${JSON.stringify(relPath)}`,
    );
  }
  if (published && (roles === undefined || roles.length === 0)) {
    throw new Error(
      `published artifacts must carry at least one role ` +
        `(requested_output and/or evidence): ${JSON.stringify(relPath)}`,
    );
  }
  if (scratch && roles !== undefined) {
    throw new Error(`scratch files are private and carry no roles: ${JSON.stringify(relPath)}`);
  }
}

function sameRoleSet(
  left: readonly ArtifactRole[] | undefined,
  right: readonly ArtifactRole[] | undefined,
): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((role) => rightSet.has(role));
}

function formatRoles(roles: readonly ArtifactRole[] | undefined): string {
  return JSON.stringify(roles ?? []);
}

function inspectArtifactDestination(runDir: string, filename: string): 'missing' | 'file' {
  const segments = filename.split(sep);
  let current = resolve(runDir);

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }

    const display = segments.slice(0, index + 1).join('/');
    if (stats.isSymbolicLink()) {
      throw new Error(
        `artifact destination contains a symlink, which is never followed: ${display}`,
      );
    }
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) {
        throw new Error(`artifact destination ancestor is not a directory: ${display}`);
      }
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`artifact destination is not a regular file: ${filename}`);
    }
    return 'file';
  }

  return 'missing';
}

function manifestPath(runDir: string): string {
  return join(runDir, MANIFEST_FILENAME);
}

function writeManifestDurably(runDir: string, manifest: Manifest): void {
  writeFileDurablyAtomic(manifestPath(runDir), serializeManifest(manifest));
}

function loadManifest(runDir: string): Manifest {
  const path = manifestPath(runDir);
  let raw: string;
  try {
    raw = readFileNoFollow(path, { maxBytes: MANIFEST_MAX_BYTES }).toString('utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`no manifest in ${runDir} — call initManifest at run start`);
    }
    if (code === 'ELOOP') {
      throw new Error(`manifest at ${path} must be a regular file; symlinks are not followed`);
    }
    if (error instanceof NoFollowFileError && error.kind === 'not_regular') {
      throw new Error(`manifest at ${path} must be a regular file`);
    }
    if (error instanceof NoFollowFileError && error.kind === 'max_bytes') {
      throw new Error(
        `manifest at ${path} is at least ${error.observedBytes} bytes, exceeding the ` +
          `${MANIFEST_MAX_BYTES}-byte read limit`,
      );
    }
    throw new Error(`could not read manifest at ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as Manifest;
  } catch (error) {
    throw new Error(`manifest at ${path} is not valid JSON: ${errorMessage(error)}`);
  }
}

function serializeManifest(manifest: Manifest): string {
  // Pretty-printed: the manifest is read by humans (auditors) as well as
  // graders.
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
