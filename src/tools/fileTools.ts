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

import { z } from 'zod';

import { detectContentFormat } from './contentReader.js';
import {
  ARTIFACTS_DIR,
  SCRATCH_DIR,
  writeArtifact,
} from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';
import type { ToolDef } from './registry.js';
import { accessKey } from './registry.js';
import { splitLines } from './lines.js';

/** Maximum source or resulting file size handled by one v3 file-tool call. */
export const V3_FILE_TOOL_MAX_BYTES = 64 * 1024 * 1024;

const LINE_NUMBER_PAD = 6;

export const readFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe(
      'Path to a UTF-8 text file under artifacts/ or scratch/, relative to the run directory',
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The 1-based line number to start reading from'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The maximum number of lines to return'),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export const writeFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe(
      'Path under scratch/ for a private working file, relative to the run directory',
    ),
  content: z.string().describe('UTF-8 text to write exactly as supplied'),
  append: z
    .boolean()
    .optional()
    .describe(
      'Append UTF-8 content to the existing exact bytes instead of overwriting; creates the file when absent',
    ),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

/** Canonical private path and exact resulting byte length. */
export interface WriteFileResult {
  path: string;
  bytes: number;
}

export const editFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe(
      'Path to an existing UTF-8 text file under scratch/, relative to the run directory',
    ),
  old_string: z
    .string()
    .describe(
      'Exact non-empty text to replace. It must occur exactly once unless replace_all is true',
    ),
  new_string: z
    .string()
    .describe('Exact replacement text, inserted verbatim'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence of old_string instead of requiring one unique match'),
});

export type EditFileInput = z.infer<typeof editFileInputSchema>;

export interface EditFileResult {
  file_path: string;
  replacement_count: number;
}

/** Read a bounded UTF-8 text file from the worker-visible run workspace. */
export const readFileTool: ToolDef<ReadFileInput> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file under artifacts/ or scratch/. Returns cat -n style line-numbered ' +
    'content; use offset and limit for a window. Run metadata and harness-private files are ' +
    'never readable. Binary files and files over 64 MiB are refused.',
  inputSchema: readFileInputSchema,
  getAccess: (input) => ({
    reads: [accessKey.file(input.file_path)],
    writes: [],
  }),
  execute(input, ctx) {
    assertNotAborted(ctx.abortSignal, 'read_file');
    const target = resolveWorkerFile(ctx.runDir, input.file_path, 'read');
    const bytes = readRegularFileNoFollow(
      target.absolutePath,
      input.file_path,
      'read_file',
    );
    const content = decodeReadableUtf8(bytes, input.file_path);
    if (content === '') {
      return 'Warning: the file exists but the contents are empty.';
    }

    const lines = splitLines(content);
    const offset = input.offset ?? 1;
    if (offset > lines.length) {
      return (
        `Warning: the file exists but is shorter than the provided offset (${offset}). ` +
        `The file has ${lines.length} lines.`
      );
    }

    const end = input.limit === undefined ? undefined : offset - 1 + input.limit;
    return lines
      .slice(offset - 1, end)
      .map(
        (line, index) =>
          `${String(offset + index).padStart(LINE_NUMBER_PAD, ' ')}→${line}`,
      )
      .join('\n');
  },
};

/** Write or append a private worker file, recording its exact resulting bytes. */
export const writeFileTool: ToolDef<WriteFileInput> = {
  name: 'write_file',
  description:
    'Write a private working file under scratch/, overwriting by default. Set append to build ' +
    'a file in pieces. This tool cannot publish artifacts; use publish_artifact for final ' +
    'outputs or evidence. Every surviving write is hashed into the run manifest. Returns the ' +
    'canonical run-relative path and exact byte count as JSON; pass that path unchanged to ' +
    'publish_artifact kind=file when publishing a workspace file.',
  inputSchema: writeFileInputSchema,
  getAccess: (input) => ({
    reads: [],
    writes: [accessKey.file(input.file_path), accessKey.manifest()],
  }),
  execute(input, ctx): WriteFileResult {
    assertNotAborted(ctx.abortSignal, 'write_file');
    const target = resolveWorkerFile(ctx.runDir, input.file_path, 'write');
    const existing = statOptionalRegularFile(
      target.absolutePath,
      input.file_path,
      'write_file',
    );

    const contentBytes = Buffer.from(input.content, 'utf8');
    let bytes = contentBytes;
    if (input.append === true && existing !== undefined) {
      assertWithinFileToolLimit(
        existing.size + contentBytes.length,
        input.file_path,
        'write_file append result',
      );
      const existingBytes = readRegularFileNoFollow(
        target.absolutePath,
        input.file_path,
        'write_file',
      );
      assertWithinFileToolLimit(
        existingBytes.length + contentBytes.length,
        input.file_path,
        'write_file append result',
      );
      bytes = Buffer.concat([existingBytes, contentBytes]);
    } else {
      assertWithinFileToolLimit(bytes.length, input.file_path, 'write_file result');
    }

    const entry = writeArtifact(ctx.runDir, target.relativePath, bytes);
    return { path: entry.filename, bytes: bytes.length };
  },
};

/** Apply one exact literal replacement to a private worker file. */
export const editFileTool: ToolDef<EditFileInput> = {
  name: 'edit_file',
  description:
    'Replace exact literal text in an existing UTF-8 file under scratch/. old_string must ' +
    'match the current bytes exactly and occur once unless replace_all is true. No whitespace, ' +
    'line-ending, Unicode, quote, or replacement-token normalization is performed. This tool ' +
    'cannot edit published artifacts.',
  inputSchema: editFileInputSchema,
  getAccess: (input) => ({
    reads: [],
    writes: [accessKey.file(input.file_path), accessKey.manifest()],
  }),
  execute(input, ctx): EditFileResult {
    assertNotAborted(ctx.abortSignal, 'edit_file');
    const target = resolveWorkerFile(ctx.runDir, input.file_path, 'write');
    const original = readRegularFileNoFollow(
      target.absolutePath,
      input.file_path,
      'edit_file',
    );
    const text = decodeEditableUtf8(original, input.file_path);

    if (input.old_string === '') {
      throw new Error(
        `edit_file requires a non-empty old_string for ${JSON.stringify(input.file_path)}. ` +
          'Use write_file to create a file or replace its full contents. Nothing was changed.',
      );
    }
    if (input.old_string === input.new_string) {
      throw new Error(
        `old_string and new_string are identical for ${JSON.stringify(input.file_path)}; ` +
          'the edit would be a no-op. Nothing was changed.',
      );
    }

    // String splitting is a literal, non-overlapping scan. Joining the
    // segments inserts replacement-token-shaped text (`$&`, `$1`, etc.)
    // verbatim instead of giving it RegExp replacement semantics.
    const segments = text.split(input.old_string);
    const replacementCount = segments.length - 1;
    if (replacementCount === 0) {
      throw new Error(
        `old_string was not found in ${JSON.stringify(input.file_path)}. No normalization is ` +
          'performed; read the file again and copy the anchor exactly. Nothing was changed.',
      );
    }
    if (input.replace_all !== true && replacementCount > 1) {
      throw new Error(
        `old_string matches ${replacementCount} locations in ${JSON.stringify(input.file_path)}, ` +
          'but edit_file requires one match unless replace_all is true. Add surrounding ' +
          'context or opt into replacing every occurrence. Nothing was changed.',
      );
    }

    const updated = Buffer.from(segments.join(input.new_string), 'utf8');
    assertWithinFileToolLimit(updated.length, input.file_path, 'edit_file result');
    const entry = writeArtifact(ctx.runDir, target.relativePath, updated);
    return {
      file_path: entry.filename,
      replacement_count: replacementCount,
    };
  },
};

interface ResolvedWorkerFile {
  absolutePath: string;
  relativePath: string;
}

/**
 * Resolve every model path through the repository chokepoint, then enforce
 * the narrower v3 visibility/mutation partition. Checking every existing
 * component with lstat prevents a lexically confined path from escaping
 * through a symlink in `scratch/` or `artifacts/`.
 */
function resolveWorkerFile(
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
function assertNoSymlinkComponents(
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

function statOptionalRegularFile(
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
function readRegularFileNoFollow(
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
  if (sizeBytes > V3_FILE_TOOL_MAX_BYTES) {
    throw new Error(
      `${operation} refused ${JSON.stringify(filePath)}: it is ${sizeBytes} bytes, over the ` +
        `${V3_FILE_TOOL_MAX_BYTES}-byte (64 MiB) file-tool limit. Nothing was changed.`,
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined, toolName: string): void {
  if (signal?.aborted === true) {
    throw new Error(`${toolName} was cancelled before it started. Nothing was changed.`);
  }
}

function decodeReadableUtf8(bytes: Buffer, filePath: string): string {
  const format = detectContentFormat({ bytes, filename: filePath });
  if (format === 'pdf' || format === 'spreadsheet' || format === 'image') {
    throw new Error(
      `${filePath} is ${format === 'image' ? 'an image' : `a ${format}`}, not UTF-8 text. ` +
        'read_file reads text files only.',
    );
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${filePath} is not valid UTF-8 text. read_file reads text files only.`,
    );
  }
}

/** Decode without stripping a BOM, then prove re-encoding preserves bytes. */
function decodeEditableUtf8(bytes: Buffer, filePath: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(filePath)}: the file is not valid UTF-8 text. ` +
        'Nothing was changed.',
    );
  }

  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(
      `Cannot edit_file ${JSON.stringify(filePath)}: UTF-8 decoding did not preserve its exact ` +
        'bytes. Nothing was changed.',
    );
  }
  return text;
}
