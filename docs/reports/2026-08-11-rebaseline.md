# Checkpoint 1 Re-Baseline Report — Evidence-Collection Agent

**Date:** August 11, 2026 (run started 2026-08-11T07:35:59Z)
**Command:** `npx tsx --env-file=.env evals/runners/cli.ts --tasks hacker_news,edgar,openclaw_pr --k 3` (same suite and k as the baseline)
**Headline: 3 of 3 tasks passed — 9/9 trials complete, 100% accuracy on every task.** The baseline was 0/3. All four mechanisms (F1–F4) show direct transcript evidence of doing their job.

Baseline for comparison: `2026-08-11-baseline.md`. Failure→mechanism log (now closed out): `.agents/planning/evidence-collection-agent-checkpoint-1/implementation/baseline-failure-log.md`.

## Results

| Task | Baseline | Re-baseline | Mean latency |
|---|---|---|---|
| Hacker News top-5 CSV | 94.4% acc, 2/3, ✗ | **100%, 3/3, PASS** | 17s |
| SEC EDGAR 8-K download | 66.7% acc, 0/3, ✗ | **100%, 3/3, PASS** | 44s |
| OpenClaw most-recent PR | 66.7% acc, 1/3, ✗ | **100%, 3/3, PASS** | 47s |

Full per-assertion detail: `evals/experiments/2026-08-11_12-41-25am_eval-hacker-news-edgar-openclaw-pr_234a61.json`. Per-trial run directories under `runs/` (paths in the results JSON).

## Blocker found and fixed before the run

The first re-baseline attempt died on turn 1 of the first trial with an API 400: `tools.9.custom.input_schema.type: Field required`. The F2 rewrite had made `download`'s input a Zod **union** of two objects ("ref or url"), and a union converts to JSON Schema as a bare top-level `anyOf` — no `"type": "object"`, which the Anthropic API requires. Every run would have failed identically; no agent behavior was involved.

Fix (commit `7233203`): the schema is a single object with optional `ref`/`url` and a runtime "exactly one of ref or url" refinement — same contract, valid schema. Verified by printing the generated JSON schema, typecheck, the 455-test suite, and then the nine live runs. Lesson for tool authors: **tool input schemas must be top-level objects**; express alternatives as optional fields plus a refinement, not `z.union`.

## Mechanism-by-mechanism verification

- **F1 — schema exactness (prompt line).** All three HN trials produced exactly `title,url,points`. The volunteered `rank` column (baseline trial 2 and both pre-baseline demos) did not recur.
- **F2 — Chrome-native download with direct-URL support.** All three EDGAR trials downloaded the real filing document with a hash match against the oracle (0/3 at baseline). Trial 3 exercised the exact designed escape path: it first saved the iXBRL viewer wrapper via the page's `/ix?doc=` link, detected that on read-back, and recovered with a direct `/Archives/` URL download whose byte size matched the filing index. Trials 1–2 went to raw archive documents directly.
- **F3 — 24-turn default.** EDGAR trials finished in 10–11 turns *including* read-back verification and exhibit downloads, where baseline trials died `budget_exceeded` at 11–12 mid-recovery. No trial approached the new ceiling; the 250k token guard remains the cost backstop.
- **F4 — initial-page anchoring (prompt line).** All three OpenClaw trials stayed on `openclaw/openclaw`; nobody wandered to the `pjasicek/OpenClaw` game engine (2/3 baseline trials derailed). Trial 3 noticed the repo's unusually high PR numbers and future-dated timestamps, flagged them as a caveat in `answer.md`, and stayed anchored — skepticism without derailment.

One environmental note: trials 1–2 answered PR #121925 and trial 3 answered #121926 — a new PR landed mid-eval. The grader's most-recent-in-window logic absorbed it; no false failure.

## What held up

- **Provenance:** manifest hashes re-verified 9/9; downloads carry final-resource URLs.
- **Prompt caching:** stable prefix cache reads on every turn ≥ 2 of all nine runs.
- **Grading integrity:** strict graders passed everything on the merits; the in-window PR check handled live-data drift as designed.

## Standing decisions affected

- **The disabled-thinking science flag:** its revival trigger (disappointing baseline accuracy) is **no longer met** — the easy suite is at 100%. Recommended: leave thinking disabled; the next accuracy lever is harder tasks, not loop changes.
- **Next open question:** the easy suite is saturated. Attribution-per-mechanism is no longer measurable here — harder tasks (the design's deferred set) are what would differentiate further changes.
