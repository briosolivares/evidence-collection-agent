// mit_sororities, minus the Google Sheet.
//
// Google revokes a signed-in session the moment a Playwright-driven Chrome
// presents it (proven 2026-08-14: 15 auth cookies on disk → 0 after one
// automated launch, and the least-detectable launch config fails too). The
// Sheet step of `mit_sororities` is therefore unreachable by browser
// automation, which made the whole task unscoreable — including the six
// assertions about research quality that have nothing to do with Sheets.
//
// This variant keeps the identical research task and the identical CSV
// grading, and drops only the Sheet URL assertion. It delegates to the
// original grader rather than reimplementing it: the point is to measure the
// same thing, so any future tightening of the CSV checks must apply here
// automatically. Failing to find the dropped assertion is an error, not a
// no-op — a silently-renamed assertion would leave this variant quietly
// grading one check fewer than it claims.

import {
  grade as gradeWithSheet,
  SHEET_ASSERTION_NAME,
} from '../../mit_sororities/grader/grader.js';
import type { AssertionResult, Grader } from '../../../types.js';

export const grade: Grader = async (runDirPath, oracleData) => {
  const all = await gradeWithSheet(runDirPath, oracleData);
  const kept = all.filter((assertion: AssertionResult) => assertion.name !== SHEET_ASSERTION_NAME);
  if (kept.length === all.length) {
    throw new Error(
      `mit_sororities_csv: expected to drop the assertion named ${JSON.stringify(SHEET_ASSERTION_NAME)} ` +
        `but the parent grader produced none by that name (got: ${all.map((a) => a.name).join('; ')})`,
    );
  }
  return kept;
};
