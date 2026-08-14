import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  readManifest,
  removeScratchArtifactEntry,
  SCRATCH_DIR,
  writeArtifact,
} from './artifacts.js';

/**
 * Run-dir-relative subtree this module reconciles: `scratch/workspace`. This
 * directory does not exist anywhere else in the codebase yet — it is
 * introduced by this feature as the place a run's shell/script tooling does
 * its own file I/O, outside the write_artifact tool call path, so the
 * manifest needs a way to catch up with it after the fact instead of before.
 */
const WORKSPACE_SUBDIR = 'workspace';
const WORKSPACE_PREFIX = `${SCRATCH_DIR}/${WORKSPACE_SUBDIR}/`;

/**
 * Per-file ceiling enforced from the opened handle's reported size, before a
 * single byte is read into memory, and again while reading in case the file
 * grows underneath the sync. Exported so a test can size a fixture against
 * it exactly without hardcoding the number twice.
 */
export const SCRATCH_WORKSPACE_MAX_FILE_BYTES = 256 * 1024 * 1024;

/** How one workspace file's manifest state changed in a sync pass. */
export type ScratchWorkspaceChange = 'created' | 'modified' | 'deleted';

/** One file whose manifest entry a sync pass added, rewrote, or removed. */
export interface ScratchWorkspaceChangedFile {
  /** Run-dir-relative path, e.g. `scratch/workspace/collect.mjs`. */
  path: string;
  change: ScratchWorkspaceChange;
}

/**
 * Reconcile the manifest with whatever `scratch/workspace` actually contains
 * right now, after a command has run.
 *
 * There is deliberately no pre-command snapshot to diff against: the
 * manifest already holds every previously-synced file's hash, so "what
 * changed" is answered by comparing the current walk against that recorded
 * state, not against a second copy of the filesystem taken a moment earlier.
 * One walk, one comparison, one source of truth.
 *
 * @param runDir - absolute path to a run directory with an initialized
 *   manifest; throws if the manifest is missing
 * @returns every created, modified, or deleted file under
 *   `scratch/workspace/`, path-sorted so callers and transcripts get a
 *   deterministic order; empty when nothing changed (including when
 *   `scratch/workspace` does not exist, which is not an error — it just
 *   means there is nothing to report)
 * @throws if a workspace entry is a symlink, socket, FIFO, device, or other
 *   non-regular file — such entries are rejected loudly rather than being
 *   followed or manifested — or if a file's size exceeds
 *   {@link SCRATCH_WORKSPACE_MAX_FILE_BYTES}
 */
export function syncScratchWorkspace(runDir: string): ScratchWorkspaceChangedFile[] {
  const workspaceDir = join(runDir, SCRATCH_DIR, WORKSPACE_SUBDIR);
  const manifest = readManifest(runDir);

  // Only the hashes already on record for this subtree matter — everything
  // else in the manifest (artifacts/, other scratch/ files) is untouched by
  // this pass and must stay that way.
  const priorHashes = new Map<string, string>();
  for (const entry of manifest.artifacts) {
    if (entry.filename.startsWith(WORKSPACE_PREFIX)) {
      priorHashes.set(entry.filename, entry.sha256);
    }
  }

  const changes: ScratchWorkspaceChangedFile[] = [];
  const seen = new Set<string>();

  if (existsSync(workspaceDir)) {
    for (const { absPath, relPath } of walkWorkspace(workspaceDir)) {
      seen.add(relPath);
      const bytes = readRegularFileNoFollow(absPath, relPath);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const priorHash = priorHashes.get(relPath);
      if (priorHash === hash) continue; // unchanged: leave the existing entry alone

      // writeArtifact recomputes this same hash and (re)writes the manifest
      // entry — it is the single write path every artifact goes through, and
      // a reconciliation pass gets no exception from that rule.
      writeArtifact(runDir, relPath, bytes);
      changes.push({ path: relPath, change: priorHash === undefined ? 'created' : 'modified' });
    }
  }

  for (const relPath of priorHashes.keys()) {
    if (seen.has(relPath)) continue;
    removeScratchArtifactEntry(runDir, relPath);
    changes.push({ path: relPath, change: 'deleted' });
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** One file found under scratch/workspace/, with both its filesystem
 * location and its run-dir-relative manifest path precomputed. */
interface WalkedWorkspaceFile {
  absPath: string;
  /** e.g. "scratch/workspace/sub/file.txt" — already in the exact form
   * writeArtifact would normalize it to, since it is built from a clean
   * directory walk with no ".." or "." segments to collapse. */
  relPath: string;
}

/**
 * Walk scratch/workspace/ once, never following a symlink.
 *
 * `readdirSync(..., { withFileTypes: true })` reports each entry's type from
 * the directory listing itself (`d_type` where the platform provides it),
 * not from following the entry — so a symlinked subdirectory is seen as a
 * symlink and rejected before this ever recurses into it or whatever it
 * points to.
 */
function walkWorkspace(workspaceDir: string): WalkedWorkspaceFile[] {
  const out: WalkedWorkspaceFile[] = [];

  function visit(dir: string, relSegments: readonly string[]): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, dirent.name);
      const relSegmentsHere = [...relSegments, dirent.name];
      const relDisplay = relSegmentsHere.join('/');

      if (dirent.isSymbolicLink()) {
        throw new Error(
          `scratch workspace entry is a symlink, which is never followed or manifested: ${relDisplay}`,
        );
      }
      if (dirent.isDirectory()) {
        visit(absPath, relSegmentsHere);
        continue;
      }
      if (!dirent.isFile()) {
        throw new Error(
          `scratch workspace entry is not a regular file (socket, FIFO, or device are ` +
            `rejected): ${relDisplay}`,
        );
      }
      out.push({ absPath, relPath: `${WORKSPACE_PREFIX}${relDisplay}` });
    }
  }

  visit(workspaceDir, []);
  return out;
}

/**
 * Read one file's exact bytes without ever following a symlink, rejecting
 * anything that is not a plain regular file, and enforcing
 * {@link SCRATCH_WORKSPACE_MAX_FILE_BYTES} both from the opened handle's
 * reported size and against the bytes actually read.
 *
 * The walk above already rejects symlinks and special files by directory
 * entry type, but that check and this read are two different moments in
 * time — the entry could be swapped for a symlink or a FIFO in between. This
 * is the second, TOCTOU-safe check on the same handle the bytes are read
 * from, mirroring `verifyManifestFiles` in ./artifacts.ts.
 */
function readRegularFileNoFollow(absPath: string, relPath: string): Buffer {
  // See verifyManifestFiles for why these two flags: O_NOFOLLOW refuses to
  // open a symlink at all, and O_NONBLOCK keeps a FIFO from hanging this
  // call forever waiting for a writer — regular files are unaffected by
  // O_NONBLOCK, so it changes nothing for the files this is meant to read.
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

  let fd: number;
  try {
    fd = openSync(absPath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(
        `scratch workspace entry is a symlink, which is never followed or manifested: ${relPath}`,
      );
    }
    throw error;
  }

  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error(
        `scratch workspace entry is not a regular file (socket, FIFO, or device are ` +
          `rejected): ${relPath}`,
      );
    }
    if (stats.size > SCRATCH_WORKSPACE_MAX_FILE_BYTES) {
      throw new Error(
        `scratch workspace entry exceeds the ${SCRATCH_WORKSPACE_MAX_FILE_BYTES}-byte ` +
          `(256 MiB) per-file limit before any of it is read into memory: ${relPath} ` +
          `(${stats.size} bytes)`,
      );
    }

    // Read in fixed-size chunks rather than trusting the size fstat just
    // reported for the whole read: the file can grow between this fstat and
    // the last byte read, and the ceiling has to hold for the entire read,
    // not just its starting point.
    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunkSize, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > SCRATCH_WORKSPACE_MAX_FILE_BYTES) {
        throw new Error(
          `scratch workspace entry grew past the ${SCRATCH_WORKSPACE_MAX_FILE_BYTES}-byte ` +
            `(256 MiB) limit while it was being read: ${relPath}`,
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}
