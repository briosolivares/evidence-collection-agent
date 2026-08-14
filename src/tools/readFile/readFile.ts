import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { detectContentFormat } from '../../content/contentReader.js';
import { resolveRunPath } from '../../run/runDir.js';
import type { ToolDef } from '../registry.js';
import { splitLines } from '../shared/lines.js';
import { accessKey } from '../registry.js';

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
 * than an error. A path escaping the run directory, a missing file, a
 * directory, or a file that is not text throws with a message naming the
 * problem — surfaced to the model as a structured error result by the
 * pipeline.
 */
export const readFileTool: ToolDef<ReadFileInput> = {
  name: 'read_file',
  description:
    'Reads a text file from the run directory. The file_path must be relative to the run directory. ' +
    'Returns the content with line numbers (cat -n style). ' +
    'Use offset and limit to read a portion of a large file. ' +
    'Binary files (PDFs, spreadsheets, images) are refused — read those with inspect_document.',
  inputSchema: readFileInputSchema,
  getAccess: (input) => ({ reads: [accessKey.file(input.file_path)], writes: [] }),
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

/** How each detected binary format should actually be read. */
const BINARY_FORMAT_ADVICE: Readonly<Record<string, string>> = {
  pdf: 'a PDF',
  spreadsheet: 'a spreadsheet',
  image: 'an image',
};

/**
 * Read a file as text, refusing bytes that are not text.
 *
 * Node's `utf8` decoding never throws on arbitrary bytes: it substitutes
 * U+FFFD and returns a string. So reading a PNG or an .xlsx used to "succeed"
 * and hand the model a page of replacement characters, which it would then
 * reason over as if it were the file's content — a silent wrong answer, and
 * the worst failure shape available. Detection is by magic number and a strict
 * decode, never by extension, because a deliverable's name is model-supplied.
 *
 * The error names the format and the tool that can actually read it, so the
 * refusal costs one turn rather than a retry loop.
 *
 * @throws a model-readable error for a missing file, a directory, or
 *   non-text bytes
 */
function readTextFile(absPath: string, givenPath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`File does not exist: ${givenPath}`);
    if (code === 'EISDIR') throw new Error(`Path is a directory, not a file: ${givenPath}`);
    throw thrown;
  }

  const advice = BINARY_FORMAT_ADVICE[detectContentFormat({ bytes, filename: givenPath })];
  if (advice !== undefined) {
    throw new Error(
      `${givenPath} is ${advice}, not text — read_file only reads text. ` +
        'Use inspect_document to extract its content.',
    );
  }

  try {
    // fatal: true is the point — it rejects exactly the byte sequences the
    // lenient decode would have turned into U+FFFD.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${givenPath} is not valid UTF-8 text — read_file only reads text. ` +
        'Use inspect_document if it is a document, or download it as an artifact.',
    );
  }
}
