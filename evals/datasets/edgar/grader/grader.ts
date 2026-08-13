import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findArtifactBySha256, readManifest, requestedOutputs, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { EdgarOracle } from '../oracle/edgarClient.js';

/** The 8-byte signature every valid PNG file starts with. */
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Grade one EDGAR 8-K task trial. Per the standing rule, reads only the run
 * directory's manifest and artifacts — never the transcript. Checks that
 * some downloaded artifact's bytes hash-match the target filing's primary
 * document, and that a PNG screenshot artifact exists, plus the standing
 * manifest-hash re-check. Screenshot *content* is not graded here — it is
 * Tier C, left to the human overlay.
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - an EdgarOracle naming the target filing and its
 *   document's bytes/hash; throws if it is not one (malformed oracle data
 *   is a harness bug, not a failed trial)
 * @returns three assertion results; a bad run yields failures with detail,
 *   never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asEdgarOracle(oracleData);
  const manifest = readManifest(runDirPath);

  const downloadEntry = findArtifactBySha256(manifest, oracle.documentSha256);
  const documentAssertion: AssertionResult = {
    name: "downloaded document hash-matches the accession's document",
    passed: downloadEntry !== undefined,
    detail:
      downloadEntry !== undefined
        ? `${downloadEntry.filename} matches sha256 ${oracle.documentSha256} (accession ${oracle.filing.accessionNumber})`
        : `no artifact matches sha256 ${oracle.documentSha256} for accession ${oracle.filing.accessionNumber} (${oracle.filing.primaryDocument})`,
  };

  const screenshotEntry = requestedOutputs(manifest).find(
    (a) => a.filename.toLowerCase().endsWith('.png') && isPngOnDisk(runDirPath, a.filename),
  );
  const screenshotAssertion: AssertionResult = {
    name: 'screenshot artifact exists with a manifest entry',
    passed: screenshotEntry !== undefined,
    detail:
      screenshotEntry !== undefined
        ? `found ${screenshotEntry.filename}`
        : 'no .png artifact with valid PNG bytes and a manifest entry was found',
  };

  return [documentAssertion, screenshotAssertion, verifyManifestHashes(runDirPath, manifest)];
};

function isPngOnDisk(runDirPath: string, filename: string): boolean {
  const absPath = join(runDirPath, filename);
  if (!existsSync(absPath)) return false;
  const header = readFileSync(absPath).subarray(0, PNG_MAGIC_BYTES.length);
  return header.equals(PNG_MAGIC_BYTES);
}

function asEdgarOracle(data: unknown): EdgarOracle {
  const obj = data as
    | { filing?: { accessionNumber?: unknown; primaryDocument?: unknown }; documentSha256?: unknown }
    | null;
  const valid =
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.filing?.accessionNumber === 'string' &&
    typeof obj.filing?.primaryDocument === 'string' &&
    typeof obj.documentSha256 === 'string';
  if (!valid) {
    throw new Error('edgar grader was handed malformed oracle data');
  }
  return data as EdgarOracle;
}
