import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readManifest, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import type { WikipediaReferenceOracle } from '../oracle/wikipediaClient.js';

const ANSWER_FILENAME = 'answer.md';
const SOURCE_ASSERTION_NAME = 'answer contains the complete source text reached from reference 275';
const TRUNCATION_ASSERTION_NAME = 'answer has no truncation marker and is long enough for the full source';

export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOracle(oracleData);
  const manifest = readManifest(runDirPath);
  const answerPath = join(runDirPath, ANSWER_FILENAME);
  const answerExists = existsSync(answerPath) && manifest.artifacts.some((entry) => entry.filename === ANSWER_FILENAME);
  const assertions: AssertionResult[] = [{
    name: `${ANSWER_FILENAME} exists with a manifest entry`,
    passed: answerExists,
    detail: answerExists ? `${ANSWER_FILENAME} found and manifested` : `${ANSWER_FILENAME} missing or unmanifested`,
  }];
  if (!answerExists) {
    return [
      ...assertions,
      { name: SOURCE_ASSERTION_NAME, passed: false, detail: `${ANSWER_FILENAME} unavailable` },
      { name: TRUNCATION_ASSERTION_NAME, passed: false, detail: `${ANSWER_FILENAME} unavailable` },
      verifyManifestHashes(runDirPath, manifest),
    ];
  }

  const answer = readFileSync(answerPath, 'utf8');
  const answerNormalized = normalize(answer);
  const sourceNormalized = normalize(oracle.sourceText);
  const containsFullSource = sourceNormalized.length > 0 && answerNormalized.includes(sourceNormalized);
  assertions.push({
    name: SOURCE_ASSERTION_NAME,
    passed: containsFullSource,
    detail: containsFullSource
      ? `full normalized text of ${oracle.sourceId} found (${oracle.sourceText.length} source characters)`
      : `full normalized text of ${oracle.sourceId} not found; reference text was "${oracle.referenceText}"`,
  });

  const answerTokens = answerNormalized.split(' ').filter(Boolean);
  const sourceTokens = sourceNormalized.split(' ').filter(Boolean);
  const markers = answer.match(/(?:\.\.\.|…|\[(?:truncated|continued)\])/gi) ?? [];
  assertions.push({
    name: TRUNCATION_ASSERTION_NAME,
    passed: markers.length === 0 && answerTokens.length >= sourceTokens.length,
    detail: `${answerTokens.length} answer token(s), ${sourceTokens.length} source token(s); truncation markers: ${markers.join(', ') || 'none'} (rendering fidelity remains human-reviewed)`,
  });
  assertions.push(verifyManifestHashes(runDirPath, manifest));
  return assertions;
};

function normalize(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asOracle(data: unknown): WikipediaReferenceOracle {
  const value = data as Partial<WikipediaReferenceOracle> | null;
  if (!value || value.referenceNumber !== 275 || typeof value.referenceId !== 'string' ||
      typeof value.referenceText !== 'string' || typeof value.sourceId !== 'string' ||
      !value.sourceId.startsWith('CITEREF') || typeof value.sourceText !== 'string' || value.sourceText.length < 20) {
    throw new Error('wikipedia_reference grader was handed malformed oracle data');
  }
  return value as WikipediaReferenceOracle;
}
