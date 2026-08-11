import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { resolveRunPath } from '../../run/runDir.js';
import type { ToolDef } from '../registry.js';
import { splitLines } from '../shared/lines.js';

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
