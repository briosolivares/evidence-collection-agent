import { existsSync } from 'node:fs';
import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import type { ToolDef } from '../registry.js';

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
