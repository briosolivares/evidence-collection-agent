import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

import { ARTIFACTS_DIR, writeArtifact } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import type { ToolDef } from '../registry.js';
import { artifactRolesInput, classifyWorkspacePath } from '../shared/evidence.js';
import { accessKey } from '../registry.js';

const writeFileInputSchema = z.strictObject({
  file_path: z
    .string()
    .describe(
      'Run-directory-relative path: artifacts/… to publish the file, scratch/… for private working files',
    ),
  content: z.string().describe('The content to write to the file'),
  append: z
    .boolean()
    .optional()
    .describe(
      'Append content to the end of the existing file instead of overwriting it ' +
        '(creates the file when absent). Use this to build a large file in pieces.',
    ),
  roles: artifactRolesInput.describe(
    'Roles for a published (artifacts/) file: requested_output for a file the task asked for, ' +
      'evidence for a supporting capture. Defaults to ["requested_output"]. Not allowed on scratch/ paths.',
  ),
});

type WriteFileInput = z.infer<typeof writeFileInputSchema>;

/**
 * `write_file` — write a file into the run directory (state-changing).
 *
 * Writes `content` to the run-dir-relative `file_path` (creating parent
 * directories as needed) through `writeArtifact`, so the write is always
 * recorded in the manifest with the content's SHA-256 — file-producing tools
 * may not bypass provenance. With `append: true` the content is added to
 * the end of the existing file (created when absent): the whole resulting
 * file goes back through `writeArtifact`, so the manifest hash always
 * covers the complete file, never a fragment. Append exists so the model
 * can build large files in pieces — long single write_file values at deep
 * context trip the decode stall (docs/reports/2026-08-12-full-suite-first-run.md,
 * failure mode 1), while writes of a few thousand characters never have.
 * The path must land under artifacts/ (published, roles recorded —
 * defaulting to requested_output) or scratch/ (private working state, no
 * roles). Returns a confirmation naming the file and whether it was
 * created, updated, or appended to. A path escaping the run directory or
 * outside the two workspace areas throws, writing nothing — surfaced to the
 * model as a structured error result by the pipeline.
 */
export const writeFileTool: ToolDef<WriteFileInput> = {
  name: 'write_file',
  description:
    'Writes a file into the run directory, overwriting if it exists ' +
    '(or appending to it with append: true — build large files in pieces this way). ' +
    'Publish every final requested output under artifacts/ (e.g. artifacts/report.csv); ' +
    'keep intermediate working files under scratch/, which is private and never graded or shown. ' +
    'Published files carry roles (default ["requested_output"]).',
  inputSchema: writeFileInputSchema,
  getAccess: (input) => ({
    reads: [],
    writes: [accessKey.file(input.file_path), accessKey.manifest()],
  }),
  execute(input, ctx) {
    const area = classifyWorkspacePath(ctx.runDir, input.file_path);
    if (area === 'scratch' && input.roles !== undefined) {
      throw new Error(
        `scratch/ files are private working state and carry no roles — omit roles, ` +
          `or publish the file under ${ARTIFACTS_DIR}/ instead: ${JSON.stringify(input.file_path)}`,
      );
    }
    const absPath = resolveRunPath(ctx.runDir, input.file_path);
    const existed = existsSync(absPath);
    // Appends serialize with all other state-changing tools (scheduler
    // contract), so read-concatenate-write cannot race another write.
    const bytes =
      input.append === true && existed
        ? Buffer.concat([readFileSync(absPath), Buffer.from(input.content, 'utf8')])
        : Buffer.from(input.content, 'utf8');
    const entry = writeArtifact(
      ctx.runDir,
      input.file_path,
      bytes,
      area === 'artifacts' ? { roles: input.roles ?? ['requested_output'] } : {},
    );
    if (input.append === true && existed) {
      return `Appended to ${entry.filename} (now ${bytes.length} bytes).`;
    }
    return existed
      ? `The file ${entry.filename} has been updated successfully.`
      : `File created successfully at: ${entry.filename}`;
  },
};
