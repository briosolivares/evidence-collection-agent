import { createHash } from 'node:crypto';

/**
 * Compute the lowercase hex SHA-256 digest of some bytes — the same encoding
 * `writeArtifact` (src/run/artifacts.ts) records in the manifest, so oracle
 * and grader code can compare digests directly without reformatting.
 *
 * @param bytes - the exact bytes to hash
 * @returns 64 lowercase hex characters
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
