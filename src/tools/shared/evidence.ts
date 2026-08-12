import { relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { ARTIFACTS_DIR, MANIFEST_FILENAME, SCRATCH_DIR } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import { TRANSCRIPT_FILENAME } from '../../run/transcript.js';

const RESERVED_RUN_METADATA_PATHS = new Set([
  MANIFEST_FILENAME,
  TRANSCRIPT_FILENAME,
  'metrics.json',
]);

/** Model-readable location and byte count for a captured artifact. */
export interface EvidenceResult {
  /** Run-directory-relative path recorded in the manifest. */
  path: string;
  /** Number of bytes written to the artifact. */
  size: number;
}

/** Which workspace area of the run directory a path lands in. */
export type WorkspaceArea = 'artifacts' | 'scratch';

/** Optional model-facing roles array shared by the publishing tools; each
 * tool attaches its own description and applies its own default when the
 * model omits it. */
export const artifactRolesInput = z
  .array(z.enum(['requested_output', 'evidence']))
  .nonempty()
  .optional();

/**
 * Confine a tool-supplied path to the run directory's workspace and say
 * which area it lands in: artifacts/ (published) or scratch/ (private
 * working state). Rejects the reserved run metadata names (manifest,
 * transcript, metrics) and any path outside the two areas; the error text
 * says where the file belongs, so one failed call is enough for the model
 * to correct course.
 */
export function classifyWorkspacePath(runDir: string, filename: string): WorkspaceArea {
  const absolutePath = resolveRunPath(runDir, filename);
  const normalizedPath = relative(resolve(runDir), absolutePath);
  if (RESERVED_RUN_METADATA_PATHS.has(normalizedPath)) {
    throw new Error(
      `Filename is reserved for run metadata: ${normalizedPath}`,
    );
  }
  if (normalizedPath.startsWith(`${ARTIFACTS_DIR}${sep}`)) return 'artifacts';
  if (normalizedPath.startsWith(`${SCRATCH_DIR}${sep}`)) return 'scratch';
  throw new Error(
    `Path ${JSON.stringify(filename)} is outside the run workspace: ` +
      `write published outputs and evidence under ${ARTIFACTS_DIR}/, ` +
      `private working files under ${SCRATCH_DIR}/.`,
  );
}

/** Confine an evidence output path to the published artifacts/ area.
 * Captures exist to be shown: they may never land in scratch/ or replace
 * the run's own records. */
export function assertEvidencePath(runDir: string, filename: string): void {
  if (classifyWorkspacePath(runDir, filename) === 'scratch') {
    throw new Error(
      `Evidence is always published — write it under ${ARTIFACTS_DIR}/, ` +
        `not ${SCRATCH_DIR}/: ${JSON.stringify(filename)}`,
    );
  }
}
