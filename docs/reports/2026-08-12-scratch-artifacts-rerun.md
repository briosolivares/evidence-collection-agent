# Medium Rerun Under the Scratch/Artifacts Contract — Both Tasks Pass

**Date:** August 12, 2026 (batch 2026-08-12T22:49–23:21Z)
**Configuration under test:** the scratch/artifacts run-dir split with manifest roles, implemented in commits `6e77876`…`7724963`: every write lands in `artifacts/` (published, non-empty `roles`) or `scratch/` (private, no roles); graders select deliverables only from `requested_output` entries; system prompt teaches the four-point workspace contract. Otherwise unchanged from the morning batch: context ceiling 900k, `maxTurns` Infinity, model `claude-sonnet-5`, atomic tool profile.
**Command:** `evals/runners/cli.ts --tasks openclaw_contributors,openclaw_merged_prs --k 3` (plus a `hacker_news --k 1` smoke beforehand).
**Results JSON:** `evals/experiments/2026-08-12_04-21-16pm_eval-openclaw-contributors-openclaw_b1866a.json`
**Baseline for comparison:** `docs/reports/2026-08-12-medium-evals.md` (same tasks, same k, pre-change code, ~16 hours earlier).

**Headline: 2/2 task passes — contributors clears the 3-for-3 consistency bar for the first time (7/7 assertions in every trial; it was 2/3 this morning), merged PRs repeats its 3/3 (8/8 everywhere). Accuracy 100% on both tasks. The new-miss-mode metric came back zero: no trial produced a single tool error — the agent never once needed steering toward the right folder or roles.** Both medium tasks now pass at the consistency bar, and the failure mode this change was built to kill is covered by a regression test rather than luck.

## Results

| Task | Accuracy | Completion | Task pass | vs. this morning |
|---|---|---|---|---|
| Top 30 contributors CSV | 100% | 3/3 | ✓ | 90.5%, 2/3, ✗ (artifact shadowing) |
| Last 10 merged PRs (screenshots + CSV) | 100% | 3/3 | ✓ | 100%, 3/3, ✓ |
| Hacker News top 5 (smoke, k=1) | 100% | 1/1 | ✓ | — |

## Per-trial metrics

| Trial | Status | Turns | Peak context | Cache read | Wall | Real cost |
|---|---|---|---|---|---|---|
| Contribs 1 (`…_338c4d`) | completed, 7/7 | 107 | 259,509 | 13.2M | 347s | ~$5.11 |
| Contribs 2 (`…_f50601`) | completed, 7/7 | 90 | 221,694 | 10.7M | 271s | ~$4.18 |
| Contribs 3 (`…_879ee1`) | completed, 7/7 | 105 | 228,683 | 10.4M | 456s | ~$4.14 |
| PRs 1 (`…_36bd5f`) | completed, 8/8 | 55 | 150,961 | 4.4M | 196s | ~$1.97 |
| PRs 2 (`…_e67882`) | completed, 8/8 | 121 | 219,847 | 13.8M | 377s | ~$5.17 |
| PRs 3 (`…_8d3ef9`) | completed, 8/8 | 67 | 173,128 | 5.4M | 204s | ~$2.41 |
| HN smoke (`…_e859b2`) | completed, 6/6 | 5 | 22,952 | 0.1M | 15s | ~$0.12 |

Cost weights as in prior reports (1× input, 1.25× cache write, 0.1× cache read, 5× output, $3/M basis). The contract adds no measurable overhead: contributors averaged 358s/trial vs. 352s this morning, with the same ~90–107-turn rhythm; PRs stayed in its 3–8-minute band. Total batch ~$23.

## The contract in the wild

What the six manifests show, trial by trial:

- **Contributors (the motivating task):** every trial published exactly **one** `requested_output` — the CSV — plus one ranking-page screenshot as `evidence`, with **18–24 scratch entries** (offloaded `inspect_page` outputs under `scratch/tool-output/`). This is precisely the layout that sank trial 2 this morning: the intermediates exist, but they now live where grading cannot see them. No trial left a deliverable-shaped stray in the published set.
- **Merged PRs (the both-roles case):** every trial published **11** requested outputs — the CSV as `["requested_output"]` and all 10 per-PR screenshots as `["requested_output","evidence"]`, exactly the dual-role designation the design predicted for explicitly requested captures (D4). The grader's role-filtered screenshot scan found a provenance-matched PNG for all 10 PRs in all three trials.
- **Steering errors: 0 across all six transcripts** — not just zero workspace bounces, zero tool errors of any kind. The plan budgeted ≤1 early bounce per run; the prompt teaching alone was sufficient.
- **Roles were never wrong:** no deliverable stranded in `scratch/`, none published evidence-only, no roles on scratch files (the write path rejects those anyway — `e6fdef8`).
- **Provenance held:** manifest hashes verified 7/7 runs (scratch files included — tamper evidence stays total); every PR screenshot carried its PR page URL.

## What closed the morning's failure

This morning's contributors trial 2 wrote a correct deliverable, but a leftover `contributors_raw.csv` sorted alphabetically first and `findArtifactByExtension` graded it instead. Three layers now stand between that bug and a grade:

1. **Structure:** intermediates live in `scratch/`, which graders never see.
2. **Selection:** all grader lookups (`findArtifactByExtension`, `findArtifactBySha256`, `findRequestedOutputByName`, screenshot scans) filter on the `requested_output` role — an evidence-only capture can't shadow a deliverable either.
3. **Regression test:** `openclaw_contributors/grader/grader.test.ts` reproduces trial 2's exact layout (raw scrape beside the published deliverable → all content assertions pass; raw scrape published alone → schema assertion fails).

The designation stays honest: the agent says *which* files answer the task, never whether they're *correct* — correctness remains entirely the grader's, against fresh oracle data.

## Watch item

The OpenClaw contributors ranking currently contains several bot accounts (`github-actions[bot]`, `clawsweeper[bot]`, `claude`, …), and trials made different judgment calls — one excluded bots and backfilled humans, others included them as ranked. The oracle's top-100 window absorbed both interpretations this batch (all trials cleared the ≥25-of-30 handle match), but a stricter window or a bot-heavier ranking could turn this ambiguity into 1–2 assertion misses. Task-text clarification territory, not a mechanism gap.

## Pointers

- Run directories: paths in the results JSON; each now has the `artifacts/` + `scratch/` shape.
- Prior reports in the medium arc: `2026-08-11-medium-baseline.md` → `2026-08-11-medium-ceiling-raise.md` → `2026-08-11-medium-rebaseline.md` → `2026-08-12-medium-evals.md` → this.
- Implementation: commits `6e77876` (schema), `3c64974` (producers), `5362555` (prompt), `aa2046c` (graders + regression), `e6fdef8` (write-path enforcement), `7724963` (docs).
