import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** How a durable file write becomes visible at its final path. */
export type DurableFileWriteMode = 'replace' | 'create';

export interface DurableFileWriteOptions {
  /**
   * `replace` atomically swaps the staged inode over any current file.
   * `create` publishes only when the destination does not exist, preserving
   * the exclusive-create behavior needed by first-time stores.
   */
  mode?: DurableFileWriteMode;
  /**
   * Exact permissions for the staged inode. When omitted, creation retains
   * Node's normal 0666-subject-to-umask behavior.
   */
  fileMode?: number;
  /**
   * Test seam at the crash-sensitive boundary: the complete temporary file
   * has been flushed, but the destination path has not changed yet.
   */
  afterTempFileSync?: (tempPath: string) => void;
  /**
   * Stable identifier for the same-directory staging file. Runtime journals
   * use this to name (and, after a crash, remove) exactly their own staging
   * inode. Omit for the usual process-id + random UUID name.
   */
  tempFileId?: string;
}

/**
 * Persist a complete file without ever exposing a partially written value.
 *
 * Replacement writes stage in the destination directory, flush the staged
 * file, atomically rename it over the destination, then flush the parent
 * directory's metadata. Exclusive creation uses a same-directory hard link
 * for its publication step: unlike rename, link fails with `EEXIST` instead
 * of clobbering a concurrently created destination. Both names refer to the
 * already-flushed inode until the temporary name is removed.
 *
 * The caller still owns write serialization. Atomic replacement prevents a
 * torn file; it does not turn a read-modify-write sequence into a transaction.
 */
export function writeFileDurablyAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: DurableFileWriteOptions = {},
): void {
  const mode = options.mode ?? 'replace';
  const parentDir = dirname(filePath);
  const tempFileId = options.tempFileId ?? `${process.pid}.${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(tempFileId)) {
    throw new Error(`invalid durable-write temporary file id: ${JSON.stringify(tempFileId)}`);
  }
  const tempPath = join(parentDir, `.${basename(filePath)}.${tempFileId}.tmp`);
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);

  let fd: number | undefined;
  let tempExists = false;
  let failure: unknown;

  try {
    fd = openSync(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      options.fileMode ?? 0o666,
    );
    tempExists = true;
    writeAll(fd, bytes);
    if (options.fileMode !== undefined) {
      fchmodSync(fd, options.fileMode);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    options.afterTempFileSync?.(tempPath);

    if (mode === 'create') {
      // linkSync is the portable same-filesystem no-replace publication
      // primitive exposed by Node. It preserves initManifest's `wx`
      // contract even when two initializers race.
      linkSync(tempPath, filePath);
      unlinkSync(tempPath);
    } else {
      renameSync(tempPath, filePath);
    }
    tempExists = false;
    fsyncDirectoryBestEffort(parentDir);
  } catch (error) {
    failure = error;
  }

  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
  }

  if (tempExists) {
    try {
      unlinkSync(tempPath);
      fsyncDirectoryBestEffort(parentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failure ??= error;
      }
    }
  }

  if (failure !== undefined) throw failure;
}

/** writeSync may legally make a short write, so exhaust the buffer. */
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) {
      throw new Error('durable file write made no progress');
    }
    offset += written;
  }
}

/**
 * Persist the directory entry change where directory descriptors can be
 * flushed. Node/Windows does not support opening directories this way, so
 * this is deliberately best-effort, matching checkpoint durability.
 */
function fsyncDirectoryBestEffort(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, 'r');
    fsyncSync(fd);
  } catch {
    // The atomic publication already happened. Some platforms provide no
    // directory-fsync primitive; do not turn that limitation into data loss.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a descriptor after its fsync is part of the same
        // best-effort platform boundary as opening the directory.
      }
    }
  }
}
