import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { resolveRunPath } from './runDir.js';

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
   * pre-V2 run directory carries, so existing readers keep working.
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
 * @returns nothing; <runDir>/manifest.json now holds valid JSON with the
 *   task text, a start timestamp, and an empty artifact list, and the
 *   artifacts/ and scratch/ subdirectories exist — the workspace layout is
 *   in place before the loop's first turn, like the manifest itself
 */
export function initManifest(runDir: string, taskText: string): void {
  const manifest: Manifest = {
    task: taskText,
    startedAt: new Date().toISOString(),
    artifacts: [],
  };
  // 'wx' fails if the file exists — the guard against double-init.
  writeFileSync(manifestPath(runDir), serializeManifest(manifest), { flag: 'wx' });
  mkdirSync(join(runDir, ARTIFACTS_DIR), { recursive: true });
  mkdirSync(join(runDir, SCRATCH_DIR), { recursive: true });
}

/**
 * Write an artifact file into the run directory and record its provenance
 * in the manifest. This is the single write path every file-producing tool
 * routes through, so provenance can never be forgotten.
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
  // Load (and thereby require) the manifest before writing the file, so a
  // missing manifest aborts the write instead of leaving untracked files.
  const manifest = loadManifest(runDir);

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);

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

  const existing = manifest.artifacts.findIndex((a) => a.filename === entry.filename);
  if (existing >= 0) {
    manifest.artifacts[existing] = entry;
  } else {
    manifest.artifacts.push(entry);
  }
  writeFileSync(manifestPath(runDir), serializeManifest(manifest));
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
  writeFileSync(manifestPath(runDir), serializeManifest(manifest));
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
  writeFileSync(manifestPath(runDir), serializeManifest(manifest));
  return updated;
}
