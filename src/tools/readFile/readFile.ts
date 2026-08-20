import { z } from 'zod';

import { detectContentFormat, splitLines } from '../contentReader.js';
import type { ToolDef } from '../registry.js';
import { accessKey } from '../registry.js';
import { assertNotAborted, readRegularFileNoFollow, resolveWorkerFile } from '../fileAccess.js';

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
  limit: z.number().int().min(1).optional().describe('The maximum number of lines to return'),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

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
    const bytes = readRegularFileNoFollow(target.absolutePath, input.file_path, 'read_file');
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
      .map((line, index) => `${String(offset + index).padStart(LINE_NUMBER_PAD, ' ')}→${line}`)
      .join('\n');
  },
};

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
    throw new Error(`${filePath} is not valid UTF-8 text. read_file reads text files only.`);
  }
}
