import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  ARTIFACTS_DIR,
  SCRATCH_DIR,
} from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';

/** Maximum source or resulting file size handled by one file-tool call. */
export const FILE_TOOL_MAX_BYTES = 64 * 1024 * 1024;

export interface ResolvedWorkerFile {
  absolutePath: string;
  relativePath: string;
}

/**
 * Resolve every model path through the repository chokepoint, then enforce
 * the narrower visibility/mutation partition. Checking every existing
 * component with lstat prevents a lexically confined path from escaping
 * through a symlink in `scratch/` or `artifacts/`.
 */
export function resolveWorkerFile(
  runDir: string,
  givenPath: string,
  access: 'read' | 'write',
): ResolvedWorkerFile {
  const absolutePath = resolveRunPath(runDir, givenPath);
  const relativePath = relative(resolve(runDir), absolutePath);
  const underArtifacts = relativePath.startsWith(`${ARTIFACTS_DIR}${sep}`);
  const underScratch = relativePath.startsWith(`${SCRATCH_DIR}${sep}`);

  if (access === 'read' && !underArtifacts && !underScratch) {
    throw new Error(
      `read_file may read only ${ARTIFACTS_DIR}/ or ${SCRATCH_DIR}/ files, never run ` +
        `metadata or internal paths: ${JSON.stringify(givenPath)}`,
    );
  }
  if (access === 'write' && !underScratch) {
    throw new Error(
      `private file mutations must stay under ${SCRATCH_DIR}/; publish final outputs through ` +
        `publish_artifact instead: ${JSON.stringify(givenPath)}`,
    );
  }

  assertNoSymlinkComponents(runDir, absolutePath, givenPath);
  return { absolutePath, relativePath };
}

/** Refuse any existing symlink from the workspace root through the target. */
export function assertNoSymlinkComponents(
  runDir: string,
  absolutePath: string,
  givenPath: string,
): void {
  const root = resolve(runDir);
  const segments = relative(root, absolutePath).split(sep);
  let current = root;

  for (const segment of segments) {
    current = resolve(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw thrown;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing ${JSON.stringify(givenPath)} because a path component is a symbolic link. ` +
          'File tools never follow links. Nothing was changed.',
      );
    }
  }
}

export function statOptionalRegularFile(
  absolutePath: string,
  givenPath: string,
  toolName: 'read_file' | 'write_file' | 'edit_file',
): Stats | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(absolutePath);
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw thrown;
  }

  if (!stat.isFile()) {
    throw new Error(
      `${toolName} cannot access ${JSON.stringify(givenPath)}: the path is not a regular file. ` +
        'Nothing was changed.',
    );
  }
  return stat;
}

/**
 * Open and read one exact regular file without following a final-component
 * symlink. The lstat component walk above supplies clear path errors; this
 * second check closes the check/read gap by validating and reading the same
 * file descriptor. Fixed-size reads enforce the ceiling even if a file grows
 * after fstat.
 */
export function readRegularFileNoFollow(
  absolutePath: string,
  givenPath: string,
  toolName: 'read_file' | 'write_file' | 'edit_file',
): Buffer {
  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);

  let fd: number;
  try {
    fd = openSync(absolutePath, flags);
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `${toolName} cannot access ${JSON.stringify(givenPath)}: file does not exist. ` +
          'Nothing was changed.',
      );
    }
    if (code === 'ELOOP') {
      throw new Error(
        `${toolName} cannot access ${JSON.stringify(givenPath)}: the path is a symbolic link. ` +
          'File tools never follow links. Nothing was changed.',
      );
    }
    throw thrown;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(
        `${toolName} cannot access ${JSON.stringify(givenPath)}: the path is not a regular file. ` +
          'Nothing was changed.',
      );
    }
    assertWithinFileToolLimit(stat.size, givenPath, toolName);

    const chunk = Buffer.alloc(1024 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      assertWithinFileToolLimit(total, givenPath, toolName);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

export function assertWithinFileToolLimit(
  sizeBytes: number,
  filePath: string,
  operation: string,
): void {
  if (sizeBytes > FILE_TOOL_MAX_BYTES) {
    throw new Error(
      `${operation} refused ${JSON.stringify(filePath)}: it is ${sizeBytes} bytes, over the ` +
        `${FILE_TOOL_MAX_BYTES}-byte (64 MiB) file-tool limit. Nothing was changed.`,
    );
  }
}

export function assertNotAborted(signal: AbortSignal | undefined, toolName: string): void {
  if (signal?.aborted === true) {
    throw new Error(`${toolName} was cancelled before it started. Nothing was changed.`);
  }
}
