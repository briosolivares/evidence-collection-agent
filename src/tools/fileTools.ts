import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { writeArtifact } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';
import type { ToolDef } from './registry.js';

// The three file tools borrow Claude Code's shapes — tool and parameter
// names (file_path / offset / limit, pattern / path), cat -n style
// line-numbered reads, grep results one match per line — because the model
// has seen those exact contracts in training and uses familiar tools
// correctly more often. The implementations are minimal Node reimplementations
// confined to the run directory: every model-supplied path goes through
// resolveRunPath, and every write goes through writeArtifact so the manifest
// records it (the design's invisible-plumbing rule).
//
// Error contract shared by all three: a violated precondition (escaping
// path, missing file, invalid pattern) throws with a model-readable message;
// the pipeline (executeToolCall) converts the throw into a structured error
// result, so callers never see an exception.

/** Width the line number is padded to in read_file output, matching Claude
 * Code's cat -n style rendering (e.g. "     1→content"). */
const LINE_NUMBER_PAD = 6;

const readFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Path to the file to read, relative to the run directory'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The line number to start reading from (1-based). Only provide if the file is too large to read at once',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The number of lines to read. Only provide if the file is too large to read at once',
    ),
});

type ReadFileInput = z.infer<typeof readFileInputSchema>;

/**
 * `read_file` — read a file from the run directory (read-only).
 *
 * Given a run-dir-relative `file_path` (with optional 1-based `offset` and
 * `limit` selecting a window of lines), returns the file's content with
 * cat -n style line numbers, numbered by true position in the file. An empty
 * file, or an offset past the last line, returns a warning message rather
 * than an error. A path escaping the run directory, a missing file, or a
 * directory throws with a message naming the problem — surfaced to the model
 * as a structured error result by the pipeline.
 */
export const readFileTool: ToolDef<ReadFileInput> = {
  name: 'read_file',
  description:
    'Reads a file from the run directory. The file_path must be relative to the run directory. ' +
    'Returns the content with line numbers (cat -n style). ' +
    'Use offset and limit to read a portion of a large file.',
  inputSchema: readFileInputSchema,
  readOnly: true,
  execute(input, ctx) {
    const absPath = resolveRunPath(ctx.runDir, input.file_path);
    const content = readTextFile(absPath, input.file_path);
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

    const window = lines.slice(offset - 1, input.limit !== undefined ? offset - 1 + input.limit : undefined);
    return window
      .map((line, i) => `${String(offset + i).padStart(LINE_NUMBER_PAD, ' ')}→${line}`)
      .join('\n');
  },
};

const writeFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Path to the file to write, relative to the run directory'),
  content: z.string().describe('The content to write to the file'),
});

type WriteFileInput = z.infer<typeof writeFileInputSchema>;

/**
 * `write_file` — write a file into the run directory (state-changing).
 *
 * Writes `content` to the run-dir-relative `file_path` (creating parent
 * directories as needed) through `writeArtifact`, so the write is always
 * recorded in the manifest with the content's SHA-256 — file-producing tools
 * may not bypass provenance. Returns a confirmation naming the file and
 * whether it was created or updated. A path escaping the run directory
 * throws, writing nothing — surfaced to the model as a structured error
 * result by the pipeline.
 */
export const writeFileTool: ToolDef<WriteFileInput> = {
  name: 'write_file',
  description:
    'Writes a file into the run directory, overwriting if it exists. ' +
    'The file_path must be relative to the run directory. ' +
    'Use this for every deliverable: notes, answers, CSVs.',
  inputSchema: writeFileInputSchema,
  readOnly: false,
  execute(input, ctx) {
    const absPath = resolveRunPath(ctx.runDir, input.file_path);
    const existed = existsSync(absPath);
    const entry = writeArtifact(ctx.runDir, input.file_path, Buffer.from(input.content, 'utf8'));
    return existed
      ? `The file ${entry.filename} has been updated successfully.`
      : `File created successfully at: ${entry.filename}`;
  },
};

const grepInputSchema = z.strictObject({
  pattern: z
    .string()
    .describe(
      'The regular expression pattern to search for in file contents. ' +
        'A plain string without regex metacharacters matches literally.',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in, relative to the run directory. Defaults to the entire run directory.',
    ),
});

type GrepInput = z.infer<typeof grepInputSchema>;

/**
 * `grep` — search file contents in the run directory (read-only).
 *
 * Tests `pattern` (a JavaScript regular expression; plain strings match
 * literally) against every line of every file under `path` — a run-dir-
 * relative file or directory, defaulting to the whole run directory. Files
 * are read as UTF-8 text and visited in a deterministic depth-first
 * lexicographic order. Returns one line per match, formatted
 * `path:line: match` with the path run-dir-relative and lines 1-based; no
 * matches returns an empty result, never an error. An invalid pattern, an
 * escaping path, or a missing search path throws with a message naming the
 * problem — surfaced to the model as a structured error result by the
 * pipeline.
 */
export const grepTool: ToolDef<GrepInput> = {
  name: 'grep',
  description:
    'Searches file contents in the run directory with a regular expression. ' +
    'Returns matching lines as path:line: match. ' +
    'Optionally restrict the search to a file or directory with path.',
  inputSchema: grepInputSchema,
  readOnly: true,
  execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      throw new Error(`Invalid regular expression pattern: ${message}`);
    }

    const searchRoot =
      input.path !== undefined ? resolveRunPath(ctx.runDir, input.path) : resolve(ctx.runDir);
    if (!existsSync(searchRoot)) {
      throw new Error(`Search path does not exist: ${input.path ?? '.'}`);
    }

    const matches: string[] = [];
    for (const filePath of collectFiles(searchRoot)) {
      const relPath = relative(resolve(ctx.runDir), filePath);
      splitLines(readFileSync(filePath, 'utf8')).forEach((line, i) => {
        if (regex.test(line)) matches.push(`${relPath}:${i + 1}: ${line}`);
      });
    }
    return matches.join('\n');
  },
};

/** The file tools in registration order, ready for `createRegistry`. */
export const fileTools: readonly ToolDef[] = [
  readFileTool as ToolDef,
  writeFileTool as ToolDef,
  grepTool as ToolDef,
];

/** Read a file as UTF-8, converting the two expected failures (missing file,
 * directory) into model-readable errors that name the offending path. */
function readTextFile(absPath: string, givenPath: string): string {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`File does not exist: ${givenPath}`);
    if (code === 'EISDIR') throw new Error(`Path is a directory, not a file: ${givenPath}`);
    throw thrown;
  }
}

/** Split text into lines on \n or \r\n; a trailing newline does not produce
 * a phantom empty final line (cat -n counts "a\nb\n" as two lines). */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Collect every file under a path (itself, if it is a file), depth-first in
 * lexicographic order so results are deterministic across runs. */
function collectFiles(absPath: string): string[] {
  if (statSync(absPath).isFile()) return [absPath];
  const files: string[] = [];
  for (const name of readdirSync(absPath).sort()) {
    files.push(...collectFiles(join(absPath, name)));
  }
  return files;
}
