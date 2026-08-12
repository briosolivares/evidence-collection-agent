# Medium-Task Evals via Sherlock — First Medium Task Pass

**Date:** August 12, 2026 (batch 2026-08-12T06:35–07:10Z)
**Configuration under test:** post-M1/M2-correction main (`99e98bf`): context ceiling 900k with `maxTurns` Infinity, contributors oracle window 100, per-trial grade persistence. Model `claude-sonnet-5`, atomic tool profile.
**Command:** driven through the Sherlock TUI's `/evals` menu (tasks `openclaw_contributors` + `openclaw_merged_prs`, k=3) — the first eval batch run end-to-end through the TUI rather than the CLI. Same load → run → oracle → grade → report path; results land in `runs/eval-results/` per the TUI convention.
**Results JSON:** `runs/eval-results/2026-08-12_12-10-32am_eval-openclaw-contributors-openclaw_c20686.json`

**Headline: merged PRs is the first medium task to clear the 3-for-3 consistency bar — 8/8 assertions in all three trials. Contributors went 2/3, and its one failure is not an agent-capability miss: the deliverable was correct, but a leftover intermediate CSV alphabetically shadowed it in the grader's artifact lookup.** All six trials completed on their own — the first medium batch with zero budget deaths.

## Results

| Task | Accuracy | Completion | Task pass | Trial endings |
|---|---|---|---|---|
| Last 10 merged PRs (screenshots + CSV) | 100% (was 70.8%) | 3/3 (was 2/3) | ✓ | 3 completed (46, 64, 115 turns) |
| Top 30 contributors CSV | 90.5% (was 14.3%) | 2/3 (was 0/3) | ✗ | 3 completed (98–100 turns) |

Prior medium runs for comparison: `2026-08-11-medium-baseline.md` (0/2, token-ceiling deaths at 11–18 turns), `2026-08-11-medium-ceiling-raise.md` (0/2, deaths at 22–28 turns), `2026-08-11-medium-rebaseline.md` (0/2, `max_turns` deaths at 60).

## Per-trial metrics

| Trial | Status | Turns | Peak context | Cache read | Wall | Real cost |
|---|---|---|---|---|---|---|
| Contribs 1 (`…_b92062`) | completed, 7/7 | 98 | 190,528 | 9.1M | 349s | ~$3.58 |
| Contribs 2 (`…_47abf9`) | completed, 5/7 | 99 | 209,406 | 10.7M | 352s | ~$4.12 |
| Contribs 3 (`…_8f14d0`) | completed, 7/7 | 100 | 194,950 | 9.8M | 356s | ~$3.79 |
| PRs 1 (`…_9f41b5`) | completed, 8/8 | 46 | 144,109 | 3.5M | 184s | ~$1.65 |
| PRs 2 (`…_8d4200`) | completed, 8/8 | 64 | 105,352 | 4.0M | 343s | ~$1.81 |
| PRs 3 (`…_92eb1e`) | completed, 8/8 | 115 | 321,394 | 23.4M | 495s | ~$8.51 |

Cost weights as in the rebaseline report (1× input, 1.25× cache write, 0.1× cache read, 5× output, $3/M basis). Two observations: the contributors task has found a stable ~99-turn, ~6-minute rhythm (its 60-turn deaths were exactly the projected ~2 turns/profile shortfall); and PRs trial 3 shows what unbounded turns buys and costs — 115 turns, 321k peak (the deepest run yet, comfortably under 900k), $8.51 for the same 8/8 the 46-turn trial got for $1.65.

## The one failure — artifact shadowing, not schema disobedience (contributors trial 2)

The grader reported the failure as a schema violation (`header: rank, github_handle, commits`; 32 rows). The run directory tells a different story. Trial 2 wrote **two** CSVs:

- `contributors_raw.csv` — a working file from the contributors-graph scrape (`rank,github_handle,commits`, 32 rows)
- `top_30_contributors.csv` — the actual deliverable: exact `github_handle,name,linkedin_url` header, 30 distinct rows

`findArtifactByExtension` (`evals/grading/manifestVerification.ts`) resolves multiple matches by taking the alphabetically first — a deliberate, documented tie-break — and `contributors_raw.csv` sorts before `top_30_contributors.csv`. Every content assertion was therefore graded against the scratch file; the deliverable was never examined.

The deliverable itself verifies clean offline: exact header, 30 distinct handles, and a 30/30 handle overlap with both oracle-passing trials (graded minutes apart against live oracle data). Had it been the graded artifact, this batch would in all likelihood have been 2/2 task passes.

The tendency is real, though: trials 1 and 3 did the same scrape without leaving a deliverable-shaped intermediate behind. The product's premise is that the run directory *is* the deliverable — a stray `.csv` in it is ambiguous evidence for any consumer, not just this grader.

**Candidate mechanisms (user's decision, per the standing rule):**

1. **Agent-side, general (aligned with the browser-first ruling):** a system-prompt line on run-directory hygiene — working/intermediate data belongs in a form that can't be mistaken for the deliverable (e.g. `.txt` scratch names, or delete/overwrite intermediates once the final artifact is written). General mechanism, no task-specific logic, testable by re-running.
2. **Grader-side:** change the multiple-match rule (newest-by-manifest-order, or grade-all-pass-any). Weakens strictness — a wrong CSV alongside a right one would pass — and polishes the grader around an agent behavior worth fixing anyway.

## What held up

- **The turn budget question is closed.** With `maxTurns` Infinity and the 900k context guard, all six trials ran to their own completion (46–115 turns). Nothing hit any ceiling; the deepest run peaked at 36% of the guard.
- **Prompt caching at depth:** uncached input stayed at ~2 tokens/turn out to 115 turns; cache reads of 9–23M per run at 0.1× weight is what makes ~100-turn runs cost $3–4 rather than $40+.
- **Provenance:** manifest hashes verified 6/6; every PR screenshot carried its source URL (30/30 across the PRs trials).
- **The TUI eval path:** menu-driven selection, per-trial live streaming, grading, report formatting, results persistence, and clean shutdown (browser + manifest teardown, exit 0) all worked on the first full-length batch. Per-trial grade persistence meant a mid-batch crash would no longer have discarded finished trials — not needed tonight, but now load-bearing.
- **Oracle stability:** both oracles (merged-PR window, contributors top-100) fetched fresh at grading time for all six trials without a retry.

## Pointers

- Per-trial run directories: paths in the results JSON; each contains `transcript.jsonl`, `manifest.json`, `metrics.json`, and all artifacts (including trial 2's two CSVs — worth eyeballing).
- Prior reports in the medium arc: `2026-08-11-medium-baseline.md` → `2026-08-11-medium-ceiling-raise.md` → `2026-08-11-medium-rebaseline.md` → this.
- Langfuse: six `run-evidence-agent` traces, 2026-08-12 06:35–07:10 UTC.
