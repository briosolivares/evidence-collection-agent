import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest, ManifestEntry } from '../../../../src/run/artifacts.js';
import {
  readManifest,
  requestedOutputs,
  verifyManifestHashes,
} from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import {
  acceptablePrsInWindow,
  type GithubPullRequest,
  type OpenClawPrOracle,
} from '../oracle/githubClient.js';

const ANSWER_ASSERTION_NAME = 'one requested answer artifact exists';
const CONTENT_ASSERTION_NAME =
  'requested answer mentions the number and title of a most-recent-in-window PR';

/**
 * Grade one OpenClaw PR task trial. Per the standing rule, reads only the
 * run directory's manifest and artifacts — never the transcript. Checks
 * that the run's sole requested output names both the number and title of a
 * pull request that was "most recent" at some point during the run's own
 * time window (the design's churn-tolerance rule — a PR filed after the run
 * ended cannot be held against it), plus the standing manifest-hash re-check.
 * The task states no filename, so the manifest's requested_output role is the
 * authority; accepting exactly one avoids both a hidden answer.md requirement
 * and grader cherry-picking among multiple guesses.
 *
 * @param runDirPath - absolute path to the trial's run directory
 * @param oracleData - an OpenClawPrOracle with enough recent PR history to
 *   cover the run's window; throws if it is not one (malformed oracle data
 *   is a harness bug, not a failed trial)
 * @returns three assertion results; a bad run yields failures with detail,
 *   never a throw
 */
export const grade: Grader = (runDirPath, oracleData) => {
  const oracle = asOpenClawPrOracle(oracleData);
  const manifest = readManifest(runDirPath);

  const outputs = requestedOutputs(manifest);
  const answerEntry = outputs.length === 1 ? outputs[0] : undefined;
  const answerExists =
    answerEntry !== undefined && existsSync(join(runDirPath, answerEntry.filename));
  const existsAssertion: AssertionResult = {
    name: ANSWER_ASSERTION_NAME,
    passed: answerExists,
    detail: answerExists
      ? `${answerEntry!.filename} found in run dir`
      : outputs.length === 0
        ? 'no artifact was published as a requested output'
        : outputs.length > 1
          ? `${outputs.length} requested outputs were published; expected one answer artifact`
          : `${outputs[0]!.filename} is listed as requested output but missing on disk`,
  };

  return [
    existsAssertion,
    mentionsPrAssertion(runDirPath, answerExists ? answerEntry : undefined, manifest, oracle),
    verifyManifestHashes(runDirPath, manifest),
  ];
};

/** The second assertion: does the answer name a PR that was legitimately
 * "most recent" at some point during the run's window? */
function mentionsPrAssertion(
  runDirPath: string,
  answerEntry: ManifestEntry | undefined,
  manifest: Manifest,
  oracle: OpenClawPrOracle,
): AssertionResult {
  const name = CONTENT_ASSERTION_NAME;

  if (answerEntry === undefined) {
    return { name, passed: false, detail: 'a unique readable requested answer is unavailable' };
  }
  if (manifest.finishedAt === undefined) {
    return { name, passed: false, detail: 'run manifest has no finishedAt (not finalized)' };
  }

  const acceptable = acceptablePrsInWindow(
    oracle.recentPrs,
    manifest.startedAt,
    manifest.finishedAt,
  );
  if (acceptable.length === 0) {
    return {
      name,
      passed: false,
      detail: 'oracle data names no PR that was most-recent during the run window',
    };
  }

  const answerText = readFileSync(join(runDirPath, answerEntry.filename), 'utf8');
  const matched = acceptable.find((pr) => mentionsPr(answerText, pr));
  return {
    name,
    passed: matched !== undefined,
    detail:
      matched !== undefined
        ? `mentions #${matched.number} "${matched.title}"`
        : `none of the window's acceptable PR(s) (${acceptable
            .map((p) => `#${p.number} "${p.title}"`)
            .join(', ')}) are both numbered and titled in ${answerEntry.filename}`,
  };
}

/** Whether `text` names both a PR's number (as a standalone number, "#42"
 * or bare "42") and its title (case-insensitive substring). */
function mentionsPr(text: string, pr: GithubPullRequest): boolean {
  const numberMentioned = new RegExp(`(?<![0-9])${pr.number}(?![0-9])`).test(text);
  const titleMentioned = text.toLowerCase().includes(pr.title.toLowerCase().trim());
  return numberMentioned && titleMentioned;
}

function asOpenClawPrOracle(data: unknown): OpenClawPrOracle {
  const recentPrs = (data as { recentPrs?: unknown } | null)?.recentPrs;
  const valid =
    Array.isArray(recentPrs) &&
    recentPrs.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as { number?: unknown }).number === 'number' &&
        typeof (p as { title?: unknown }).title === 'string' &&
        typeof (p as { createdAt?: unknown }).createdAt === 'string',
    );
  if (!valid) {
    throw new Error('openclaw_pr grader was handed malformed oracle data');
  }
  return data as OpenClawPrOracle;
}
