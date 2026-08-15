export const MIT_SORORITIES = [
  'Alpha Chi Omega',
  'Alpha Phi',
  'Delta Phi Epsilon',
  'Kappa Alpha Theta',
  'Pi Beta Phi',
  'Sigma Kappa',
] as const;

/** A sorority/class cohort the live web does not source, so its absence
 * from the CSV must not fail the grade. */
export interface OptionalCohort {
  affiliation: (typeof MIT_SORORITIES)[number];
  classYear: number;
}

/** Structural oracle. The chapter rosters and the private Google Sheet do
 * not expose a stable unauthenticated API; identity/content fidelity is
 * therefore confirmed by the standing human overlay. */
export interface MitSororitiesOracle {
  affiliations: typeof MIT_SORORITIES;
  classes: readonly [2026, 2027];
  /** Cohorts the official sites do not publish (website answers are the
   * ground truth). Re-check each live page before tightening any of these
   * again — a waiver that outlives its cause hides a real miss.
   *
   * - Pi Beta Phi 2026. Verified 2026-08-13: mit.pibetaphi.org/members
   *   lists Class of 2027/2028/2029 tables only — no 2026 (senior) table —
   *   and the Wayback Machine has no capture of the URL to consult a prior
   *   version.
   * - Alpha Chi Omega 2026. Verified 2026-08-14: axo.mit.edu/sisters
   *   carries exactly four class headings, `<h1>Class of 2030/2029/2028/
   *   2027</h1>`, with no 2026 section anywhere on the page. Found because
   *   a trial was failed for "missing cohort: Alpha Chi Omega 2026" while
   *   its own answer.md correctly reported the roster as unpublished and
   *   cited the page; an independent fetch confirmed the agent, not the
   *   grader. */
  optionalCohorts: readonly OptionalCohort[];
  minRows: number;
  maxRows: number;
  minMajorCoverage: number;
  minEnrichmentCoverage: number;
}

export async function fetchOracle(): Promise<MitSororitiesOracle> {
  return {
    affiliations: MIT_SORORITIES,
    classes: [2026, 2027],
    optionalCohorts: [
      { affiliation: 'Pi Beta Phi', classYear: 2026 },
      { affiliation: 'Alpha Chi Omega', classYear: 2026 },
    ],
    // One member per required cohort: 12 cohorts minus the optional ones.
    minRows: 10,
    maxRows: 400,
    minMajorCoverage: 0.5,
    minEnrichmentCoverage: 0.25,
  };
}
