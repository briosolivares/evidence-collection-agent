import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILENAME, type Manifest, type ManifestEntry } from '../../src/run/artifacts.js';
import type { AssertionResult } from '../types.js';
import { sha256Hex } from './hash.js';

/**
 * Read and parse a run directory's manifest.
 *
 * @param runDirPath - absolute path to a run directory
 * @returns the parsed manifest
 * @throws if `manifest.json` is missing under `runDirPath` or is not valid
 *   JSON
 */
export function readManifest(runDirPath: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(join(runDirPath, MANIFEST_FILENAME), 'utf8');
  } catch {
    throw new Error(`${MANIFEST_FILENAME} missing or unreadable in ${runDirPath}`);
  }
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    throw new Error(`${MANIFEST_FILENAME} in ${runDirPath} is not valid JSON`);
  }
}

/**
 * Standing provenance check every grader runs: re-hash every artifact the
 * manifest lists and confirm it still matches the bytes on disk. This is
 * the tamper-evidence property the manifest exists for — an artifact
 * changed after capture, behind the manifest's back, must be caught here
 * regardless of what any task-specific assertion checks.
 *
 * @param runDirPath - absolute path to the run directory holding the
 *   artifacts named in `manifest`
 * @param manifest - the run's manifest, as returned by `readManifest`
 * @returns one assertion, named "manifest hashes verify", passing iff every
 *   listed artifact exists on disk with a SHA-256 matching its recorded
 *   entry (an empty artifact list passes vacuously — there is nothing to
 *   contradict); a mismatch or missing file names the offending path(s) in
 *   the detail
 */
export function verifyManifestHashes(runDirPath: string, manifest: Manifest): AssertionResult {
  const name = 'manifest hashes verify';
  const problems: string[] = [];

  for (const entry of manifest.artifacts) {
    const absPath = join(runDirPath, entry.filename);
    if (!existsSync(absPath)) {
      problems.push(`${entry.filename}: listed in manifest but missing on disk`);
      continue;
    }
    const actual = sha256Hex(readFileSync(absPath));
    if (actual !== entry.sha256) {
      problems.push(`${entry.filename}: manifest sha256 ${entry.sha256}, disk sha256 ${actual}`);
    }
  }

  return problems.length === 0
    ? { name, passed: true, detail: `${manifest.artifacts.length} artifact(s) verified` }
    : { name, passed: false, detail: problems.join('; ') };
}

/**
 * Find the manifest entry whose filename has the given extension.
 *
 * @param manifest - the run's manifest
 * @param extension - a filename extension including the leading dot (e.g.
 *   `.csv`), matched case-insensitively
 * @returns the matching entry with the lexicographically smallest filename,
 *   when one or more match (a deterministic, documented tie-break rather
 *   than an ambiguous pick); `undefined` when none match
 */
export function findArtifactByExtension(
  manifest: Manifest,
  extension: string,
): ManifestEntry | undefined {
  const lowerExt = extension.toLowerCase();
  const matches = manifest.artifacts
    .filter((a) => a.filename.toLowerCase().endsWith(lowerExt))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  return matches[0];
}

/**
 * Find the manifest entry recording a given SHA-256 hash.
 *
 * @param manifest - the run's manifest
 * @param sha256Hash - lowercase hex SHA-256 to look for among recorded
 *   artifact hashes
 * @returns the first matching entry in manifest order, or `undefined` when
 *   no artifact's recorded hash equals `sha256Hash`
 */
export function findArtifactBySha256(
  manifest: Manifest,
  sha256Hash: string,
): ManifestEntry | undefined {
  return manifest.artifacts.find((a) => a.sha256 === sha256Hash);
}
