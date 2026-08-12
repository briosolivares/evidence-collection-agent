import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILENAME, type Manifest } from '../../../../src/run/artifacts.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { StubOracle } from '../oracle/oracle.js';

/**
 * Grade one stub-task trial. Per the standing rule, reads only the run
 * directory's manifest and artifacts. Two assertions: the expected
 * deliverable exists, and its manifest entry's hash matches the bytes on
 * disk (the provenance re-check every real grader will also make).
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - a StubOracle naming the expected deliverable; throws
 *   if it is not one (malformed oracle data is a harness bug, not a failed
 *   trial)
 * @returns exactly two assertion results; a bad run yields failures with
 *   detail, never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const { expectedFile } = asStubOracle(oracleData);

  const exists = existsSync(join(runDirPath, expectedFile));
  return [
    {
      name: `${expectedFile} exists`,
      passed: exists,
      detail: exists
        ? `${expectedFile} found in run dir`
        : `${expectedFile} missing from run dir`,
    },
    manifestHashAssertion(runDirPath, expectedFile),
  ];
};

function asStubOracle(data: unknown): StubOracle {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { expectedFile?: unknown }).expectedFile !== 'string'
  ) {
    throw new Error('stub grader was handed malformed oracle data');
  }
  return data as StubOracle;
}

/** Check that the manifest lists the file and its recorded hash matches the bytes on disk. */
function manifestHashAssertion(runDirPath: string, filename: string): AssertionResult {
  const name = `manifest hash verifies for ${filename}`;

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(runDirPath, MANIFEST_FILENAME), 'utf8')) as Manifest;
  } catch {
    return { name, passed: false, detail: `${MANIFEST_FILENAME} missing or unreadable` };
  }

  const entry = manifest.artifacts.find(
    (a) => a.filename === filename && (a.roles?.includes('requested_output') ?? false),
  );
  if (entry === undefined) {
    return { name, passed: false, detail: `no requested-output manifest entry for ${filename}` };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(join(runDirPath, filename));
  } catch {
    return { name, passed: false, detail: `${filename} listed in manifest but unreadable` };
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual === entry.sha256
    ? { name, passed: true, detail: `sha256 ${actual} matches manifest` }
    : { name, passed: false, detail: `sha256 mismatch: manifest ${entry.sha256}, disk ${actual}` };
}
