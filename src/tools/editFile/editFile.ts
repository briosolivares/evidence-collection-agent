import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { accessKey } from '../registry.js';
import {
  assertNotAborted,
  assertWithinFileToolLimit,
  readRegularFileNoFollow,
  resolveWorkerFile,
} from '../fileAccess.js';

export const editFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Path to an existing UTF-8 text file under scratch/, relative to the run directory'),
  old_string: z
    .string()
    .describe(
      'Exact non-empty text to replace. It must occur exactly once unless replace_all is true',
    ),
  new_string: z.string().describe('Exact replacement text, inserted verbatim'),
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
    const original = readRegularFileNoFollow(target.absolutePath, input.file_path, 'edit_file');
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
