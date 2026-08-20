import { z } from 'zod';

import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import {
  assertNotAborted,
  assertWithinFileToolLimit,
  readRegularFileNoFollow,
  resolveWorkerFile,
  statOptionalRegularFile,
} from '../fileAccess.js';

export const writeFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Path under scratch/ for a private working file, relative to the run directory'),
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
  execute(input, ctx): WriteFileResult {
    assertNotAborted(ctx.abortSignal, 'write_file');
    const target = resolveWorkerFile(ctx.runDir, input.file_path, 'write');
    const existing = statOptionalRegularFile(target.absolutePath, input.file_path, 'write_file');

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
