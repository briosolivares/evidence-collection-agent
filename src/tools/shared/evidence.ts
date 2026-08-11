import { relative, resolve } from 'node:path';

import { MANIFEST_FILENAME } from '../../run/artifacts.js';
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

/** Confine an evidence output path to the run directory and reject the
 * reserved run metadata files (manifest, transcript, metrics) — evidence
 * tools may never replace the run's own records. */
export function assertEvidencePath(runDir: string, filename: string): void {
  const absolutePath = resolveRunPath(runDir, filename);
  const normalizedPath = relative(resolve(runDir), absolutePath);
  if (RESERVED_RUN_METADATA_PATHS.has(normalizedPath)) {
    throw new Error(
      `Evidence filename is reserved for run metadata: ${normalizedPath}`,
    );
  }
}
