# Medium-Task Ceiling-Raise Experiment (Step 0) — Evidence-Collection Agent

**Date:** August 11, 2026 (run started 2026-08-11T21:51:35Z)
**Change under test:** `DEFAULT_MAX_TOKENS` 250,000 → 750,000 and `DEFAULT_MAX_TURNS` 24 → 60 in `src/cli/runTask.ts`.
**Command:** `npx tsx --env-file=.env evals/runners/cli.ts --tasks openclaw_merged_prs,openclaw_contributors --k 3`
**Headline: 0 of 2 tasks passed — all six trials died `budget_exceeded` on the raised 750k ceiling at 22–28 turns.** Tripling the cumulative ceiling bought only ~1.6–2× the turns, exactly the square-root scaling the cumulative measure predicts. Raising the ceiling further is not a viable path; the experiment confirms the spec's Parts 1–2 as the durable fix.

Results JSON: `evals/experiments/2026-08-11_03-01-54pm_eval-openclaw-merged-prs-openclaw_9b092f.json`. Prior baseline for comparison: `docs/reports/2026-08-11-medium-baseline.md` (same tasks at the 250k ceiling: 0/2, deaths at 11–18 turns).

## Results

| Task | Accuracy | Completion | Task pass | Mean latency | Trial endings |
|---|---|---|---|---|---|
| Last 10 merged PRs (screenshots + CSV) | 12.5% | 0/3 | ✗ | 113s | token ceiling at 22–28 turns, 770–802k cumulative |
| Top 30 contributors CSV | 14.3% | 0/3 | ✗ | 90s | token ceiling at 22–24 turns, 768–799k cumulative |

As in the baseline, the only passing assertion anywhere was the manifest-hash check (6/6). No trial wrote its CSV; every content assertion failed downstream of that.

## Per-trial detail

| Trial | Turns | Cumulative in+out+cache_read | Peak per-request input | Partial progress at death |
|---|---|---|---|---|
| merged-PRs 1 (`…_c8660e`) | 28 | 769,594 | 42k | 3 of 10 PR screenshots |
| merged-PRs 2 (`…_fdd500`) | 22 | 801,650 | 65k | 1 of 10 screenshots |
| merged-PRs 3 (`…_7c5c00`) | 22 | 771,945 | 81k | 2 of 10 screenshots |
| contributors 1 (`…_ec1c78`) | 22 | 771,203 | 55k | list collection |
| contributors 2 (`…_3d44a5`) | 22 | 798,766 | 58k | `contributors_raw_list.txt` written |
| contributors 3 (`…_012b27`) | 24 | 767,534 | 72k | past list collection, enriching profiles (LinkedIn lookups) |

## What the experiment established

1. **The cumulative ceiling fights quadratic growth and loses.** Only the ~3k static prefix caches (`cache_read` = 2,979 flat on every turn, all six trials), so each turn re-pays the entire growing conversation as fresh input. Per-request input grows ~3k tokens/turn; the cumulative sum is therefore ~quadratic in turns, and turns-at-death scale with √ceiling. Observed: 3× the ceiling → 1.6–2× the turns (11–18 → 22–28), matching √3 ≈ 1.73. Finishing row 6 (~50–70 turns, see below) under a cumulative ceiling would take roughly 2.5–4M tokens.
2. **True task depth is ~50–70 turns for both tasks.** Merged PRs: list building + ordering verification took ~10 turns, then ~5 turns per PR (navigate → inspect → grep → screenshot → record) with 3 of 10 done by turn 28. Contributors: trials now got *past* the baseline's scroll-loop wall and into per-profile name/LinkedIn enrichment (~1.5–2 turns per profile × 30, plus ~10 turns of list collection). Neither ceiling change altered judgment — transcripts stay sensible to the last turn; agents ran out of tokens, not ideas, for the third report running.
3. **The 60-turn cap never bound (max 28)** — but the old 24-turn default would have bound trial 1, and the ~50–70-turn depth estimate says 24 was too low for medium tasks regardless of tokens. Keep 60 through Step 1.
4. **Real cost of the no-caching status quo:** ~685–733k uncached input per trial ≈ $2.1–2.3/trial at Sonnet 5 list prices. With the spec's Part 1 (moving breakpoint), most of that becomes 0.1× cache reads — ~$0.3–0.5/trial, before any completion improvement.

## Calibration for the spec's open decision (`maxContextTokens` default)

Peak *per-request* context (input + cache_read + output for one request) reached 46–84k at turns 22–28, growing ~3k/turn. Projected to the ~50–70-turn completion depth: **~150–220k per-request context at task completion.**

- **100,000 would bind before completion** (~turn 33 at the observed growth rate) — rejected by this data.
- **200,000 (the spec's proposed default) is the right choice**, with the caveat that 60–70-turn runs will brush against it; if Step 2 shows deaths at 200k, the remedy is cheaper repeat-page representation (baseline report mechanism 3), not a bigger number.

## What held up

- **Provenance:** manifest hashes verified 6/6, including partial-progress artifacts.
- **Graders and oracles:** fail-fast diagnostics named the missing CSV in every trial; oracle fetches ran without rate-limit trouble.
- **Prefix caching integrity:** `cache_read` was byte-stable at 2,979 tokens on every warm request across all six trials — the static prefix never broke, and trials 2–6 even warm-started from the previous trial's cache.

## Next step

Implement spec Parts 1–4 (Step 1), then re-baseline (Step 2). The `runTask.ts` defaults changed here are interim: Part 2 replaces `DEFAULT_MAX_TOKENS` with `DEFAULT_MAX_CONTEXT_TOKENS = 200_000`; `DEFAULT_MAX_TURNS = 60` stays. Note for Step 2's report: `metrics.json` from Step 1 onward is not comparable with this report (budget semantics change; compare via `peakContextTokens` and derived real cost).
