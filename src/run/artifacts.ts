import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { resolveRunPath } from './runDir.js';

/** Name of the manifest file inside every run directory. */
export const MANIFEST_FILENAME = 'manifest.json';

/** Provenance record for one artifact in the run directory. */
export interface ManifestEntry {
  /** Run-dir-relative path of the artifact file. */
  filename: string;
  /** Lowercase hex SHA-256 of the artifact's exact bytes at capture time. */
  sha256: string;
  /** URL the artifact was captured from, when one applies. */
  sourceUrl?: string;
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
}

/**
 * Create the run's manifest, recording the task text and start time.
 *
 * @param runDir - absolute path to an existing run directory that does not
 *   yet contain a manifest; throws if one already exists (double-init is a
 *   bug, and overwriting would erase recorded provenance)
 * @param taskText - the task the run was started with, recorded verbatim
 * @returns nothing; <runDir>/manifest.json now holds valid JSON with the
 *   task text, a start timestamp, and an empty artifact list
 */
export function initManifest(runDir: string, taskText: string): void {
  const manifest: Manifest = {
    task: taskText,
    startedAt: new Date().toISOString(),
    artifacts: [],
  };
  // 'wx' fails if the file exists — the guard against double-init.
  writeFileSync(manifestPath(runDir), serializeManifest(manifest), { flag: 'wx' });
}

/**
 * Write an artifact file into the run directory and record its provenance
 * in the manifest. This is the single write path every file-producing tool
 * routes through, so provenance can never be forgotten.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; throws (writing nothing) if the manifest is missing
 * @param relPath - relative path for the artifact, confined to the run
 *   directory (see resolveRunPath); throws (writing nothing) if it escapes.
 *   Missing parent directories are created
 * @param bytes - the artifact's content, written to disk exactly as given
 * @param meta - optional provenance; a given sourceUrl is recorded in the
 *   artifact's manifest entry
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
  // Load (and thereby require) the manifest before writing the file, so a
  // missing manifest aborts the write instead of leaving untracked files.
  const manifest = loadManifest(runDir);

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);

  const entry: ManifestEntry = {
    // Normalizing through the resolved path makes equivalent spellings
    // ("data.csv", "./data.csv") collide onto one manifest entry.
    filename: relative(resolve(runDir), absPath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(meta.sourceUrl !== undefined ? { sourceUrl: meta.sourceUrl } : {}),
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
