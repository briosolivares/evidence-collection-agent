import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest } from '../../../../src/run/artifacts.js';
import { readManifest, verifyManifestHashes } from '../../../grading/manifestVerification.js';
import type { AssertionResult, Grader } from '../../../types.js';
import {
  acceptablePrsInWindow,
  type GithubPullRequest,
  type OpenClawPrOracle,
} from '../oracle/githubClient.js';

/** Run-dir-relative path of the deliverable this task's answer must land in
 *  (the system prompt's own naming convention for natural-language answers). */
const ANSWER_FILENAME = 'answer.md';

/**
 * Grade one OpenClaw PR task trial. Per the standing rule, reads only the
 * run directory's manifest and artifacts — never the transcript. Checks
 * that `answer.md` exists and names both the number and title of a pull
 * request that was "most recent" at some point during the run's own time
 * window (the design's churn-tolerance rule — a PR filed after the run
 * ended cannot be held against it), plus the standing manifest-hash
 * re-check.
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

  const answerExists = existsSync(join(runDirPath, ANSWER_FILENAME));
  const existsAssertion: AssertionResult = {
    name: `${ANSWER_FILENAME} exists`,
    passed: answerExists,
    detail: answerExists
      ? `${ANSWER_FILENAME} found in run dir`
      : `${ANSWER_FILENAME} missing from run dir`,
  };

  return [
    existsAssertion,
    mentionsPrAssertion(runDirPath, answerExists, manifest, oracle),
    verifyManifestHashes(runDirPath, manifest),
  ];
};

/** The second assertion: does the answer name a PR that was legitimately
 * "most recent" at some point during the run's window? */
function mentionsPrAssertion(
  runDirPath: string,
  answerExists: boolean,
  manifest: Manifest,
  oracle: OpenClawPrOracle,
): AssertionResult {
  const name = `${ANSWER_FILENAME} mentions the number and title of a most-recent-in-window PR`;

  if (!answerExists) {
    return { name, passed: false, detail: `${ANSWER_FILENAME} missing from run dir` };
  }
  if (manifest.finishedAt === undefined) {
    return { name, passed: false, detail: 'run manifest has no finishedAt (not finalized)' };
  }

  const acceptable = acceptablePrsInWindow(oracle.recentPrs, manifest.startedAt, manifest.finishedAt);
  if (acceptable.length === 0) {
    return {
      name,
      passed: false,
      detail: 'oracle data names no PR that was most-recent during the run window',
    };
  }

  const answerText = readFileSync(join(runDirPath, ANSWER_FILENAME), 'utf8');
  const matched = acceptable.find((pr) => mentionsPr(answerText, pr));
  return {
    name,
    passed: matched !== undefined,
    detail:
      matched !== undefined
        ? `mentions #${matched.number} "${matched.title}"`
        : `none of the window's acceptable PR(s) (${acceptable
            .map((p) => `#${p.number} "${p.title}"`)
            .join(', ')}) are both numbered and titled in ${ANSWER_FILENAME}`,
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
