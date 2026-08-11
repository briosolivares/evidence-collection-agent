# Medium eval tasks — build log

Started 2026-08-11 after the re-baseline saturated the easy suite (3/3 at 100%). Design-doc rows 4–8 are the medium set; this doc records which are built, the user's decisions, and the grader-design choices that need to survive a session boundary.

## Decisions (user-made, 2026-08-11)

- **Q: Which medium tasks first?** A: build #6 (last 10 merged OpenClaw PRs) and #8 (top 30 OpenClaw contributors). Tasks 4 (multi-site screenshots), 5 (YC founders), 7 (X/Twitter — blocked on an auth decision) wait.
- **Q: GitHub token?** A: yes — oracles read `GITHUB_TOKEN` from the environment (optional; unauthenticated still works at 60 req/hr, but one grading pass of both tasks is ~70 calls, so the token is effectively required for real eval runs). **User still needs to add `GITHUB_TOKEN=...` to `.env`.** Shared helper: `evals/oracles/githubApi.ts`; the openclaw_pr oracle was switched onto it too.
- **Q: Raise the 250k token ceiling for deeper tasks?** A: keep 250k for now. Expect `budget_exceeded` data from task 6 (EDGAR already ran 234–251k at ~10 turns; task 6 is ~10 PR pages + 10 screenshots).

## Task packages built

### `openclaw_merged_prs` (design row 6)

CSV columns (exact, per the standing ruling): `pr_number, committer, reviewer, merger`; plus a full-page screenshot per PR. Grader-design choices:

- **"Recently merged" oracle window of 30** (REST has no merged-at sort; `state=closed&sort=updated` over 100 entries is the proxy — a merge updates the PR). Membership = the CSV's PRs must be in this window; 3× the task's 10 absorbs merge churn between run and grading.
- **Detail calls (merged_by + reviews) only for the newest 15** — people-correctness (committer=author, merger=merged_by) is checked only for rows in that detailed subset; rows outside pass vacuously with transparent detail.
- **Reviewer semantics:** checked only for PRs with *submitted* reviews (a PR's sidebar also shows requested-but-silent reviewers, so naming one on a review-less PR can't be called wrong); the cell must name at least one actual review submitter, author excluded.
- **Screenshot check is provenance-based:** for each CSV PR, some PNG artifact (magic bytes verified) must carry a `sourceUrl` matching `openclaw/openclaw/pull/<n>`. "Full-page"-ness is Tier C (human overlay), as with edgar.
- People cells tolerate decoration ("@login", "login (Name)") via word-boundary login matching.

### `openclaw_contributors` (design row 8)

CSV columns (exact): `github_handle, name, linkedin_url`. Grader-design choices:

- **Oracle window 40, tolerance ≥25 of 30 handles in-window** — absorbs bot-filtering and ranking-edge disagreements between the API and the website's contributors graph.
- **Names graded only where both sides have one** (oracle profile name non-null AND cell non-empty): containment either way, case-insensitive. Empty cells are "no answer", not wrong — some profiles have no public name.
- **LinkedIn column is shape-only** (empty-ish or a linkedin.com URL): GitHub doesn't know LinkedIn URLs and LinkedIn offers no oracle; correctness is Tier C. Documented in the oracle client docstring.

## Shared additions

- `evals/oracles/githubApi.ts` — token-aware GitHub API access (headers + `githubGetJson` with a rate-limit-naming error). Used by all three GitHub oracles.
- `evals/grading/csvAssertions.ts` — `exactColumnsAssertion`, the standing exact-columns ruling as a reusable helper (hacker_news keeps its private copy; not churned).

## State / next steps

- Both packages: typecheck clean, full suite green (500 tests / 83 files), parsers smoke-tested against live GitHub.
- Token added by the user (verified via `/rate_limit`: 5,000/hr); oracles fetched cleanly for all six gradings.
- **Baseline run 2026-08-11T08:47Z: 0/2 — all six trials `budget_exceeded` on the 250k token ceiling before writing the CSV** (turns never bound; max 18 of 24). Report: `docs/reports/2026-08-11-medium-baseline.md`. Row 6 needs ~3× the ceiling at current caching; row 8 burned the budget scrolling GitHub's lazy-loading contributors graph.
- **Open decision (user's):** candidate mechanisms — conversation-depth caching, budget redefinition to uncached-only, and/or a raised ceiling; recommended first step is a raised-ceiling re-run to measure true task depth. Grader content assertions are still unexercised by a real run (all failed downstream of no-CSV).
