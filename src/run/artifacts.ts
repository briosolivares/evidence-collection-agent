import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Run-dir subdirectory holding tool-managed checklist state. */
export const CHECKLIST_DIR = 'checklist';

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
   * lives under artifacts/ — scratch and checklist entries carry no roles. */
  roles?: ArtifactRole[];
  /** ISO 8601 timestamp of when the artifact was written. */
  capturedAt: string;
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
  /** Internal discriminator for the run-scoped checklist store. Checklist
   * entries are hashed for provenance but are neither published artifacts nor
   * private scratch files, and therefore carry no roles or source URL. */
  managedState?: 'checklist';
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
 *   artifacts/, scratch/, and checklist/ subdirectories exist — the run
 *   layout is in place before the loop's first turn, like the manifest itself
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
  mkdirSync(join(runDir, CHECKLIST_DIR), { recursive: true });
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
 *   (published — non-empty roles required), scratch/ (private — roles
 *   forbidden), or checklist/ when the internal managed-state discriminator
 *   is present; throws (writing nothing) if it escapes or breaks the
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
 * Delete one internally managed checklist file and its matching provenance
 * entry. The path is confined and partition-checked before any mutation, and
 * the manifest is loaded first so a missing manifest can never leave an
 * untracked deletion behind.
 *
 * Missing files are a no-op and return false. This preserves the manifest when
 * a caller races with an already-completed deletion. An existing file without
 * a matching manifest entry is rejected, preserving the meaning of "tracked"
 * and leaving the file untouched.
 */
export function deleteTrackedRunFile(
  runDir: string,
  relPath: string,
  meta: { managedState: 'checklist' },
): boolean {
  const absPath = resolveRunPath(runDir, relPath);
  const filename = relative(resolve(runDir), absPath);
  assertWorkspacePartition(filename, relPath, meta);

  // Require the manifest before checking or mutating the tracked file.
  const manifest = loadManifest(runDir);
  if (!existsSync(absPath)) {
    return false;
  }

  const existing = manifest.artifacts.findIndex((a) => a.filename === filename);
  if (existing < 0) {
    throw new Error(`no manifest entry for tracked checklist file: ${JSON.stringify(relPath)}`);
  }

  unlinkSync(absPath);
  manifest.artifacts.splice(existing, 1);
  writeFileSync(manifestPath(runDir), serializeManifest(manifest));
  return true;
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
 * Enforce the run partition at the single write path: published artifacts
 * carry roles, private scratch files do not, and internal checklist state is
 * accepted only through its explicit discriminator.
 */
function assertWorkspacePartition(
  filename: string,
  relPath: string,
  meta: ArtifactMeta,
): void {
  const published = filename.startsWith(`${ARTIFACTS_DIR}${sep}`);
  const scratch = filename.startsWith(`${SCRATCH_DIR}${sep}`);
  const checklist = filename.startsWith(`${CHECKLIST_DIR}${sep}`);
  if (!published && !scratch && !checklist) {
    throw new Error(
      `artifact path must be under ${ARTIFACTS_DIR}/ (published) or ` +
        `${SCRATCH_DIR}/ (private working files): ${JSON.stringify(relPath)}`,
    );
  }
  if (checklist) {
    if (meta.managedState !== 'checklist') {
      throw new Error(
        `checklist files require the internal managedState discriminator ` +
          `"checklist": ${JSON.stringify(relPath)}`,
      );
    }
    if (meta.roles !== undefined || meta.sourceUrl !== undefined) {
      throw new Error(
        `checklist files cannot carry roles or sourceUrl: ${JSON.stringify(relPath)}`,
      );
    }
    return;
  }
  if (meta.managedState !== undefined) {
    throw new Error(
      `managedState is only allowed for checklist files: ${JSON.stringify(relPath)}`,
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
