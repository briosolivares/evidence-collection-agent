# Medium-Task Re-Baseline (Step 2) — Moving Breakpoint + Per-Request Context Guard

**Date:** August 11, 2026 (runs 2026-08-11T23:02–23:24Z, graded 23:26Z)
**Changes under test:** spec Parts 1–4 (`.agents/planning/2026-08-11-cache-context-guard/spec.md`, commit `8d0ea98`): moving conversation cache breakpoint, per-request context guard (200k, replacing the 250k cumulative budget), cache-miss tripwire, 200k-byte per-message batch cap. `maxTurns` 60.
**Command:** `npx tsx --env-file=.env evals/runners/cli.ts --tasks openclaw_merged_prs,openclaw_contributors --k 3` (graded via `evals/runners/regrade.ts` — see Eval-infra fragility below).
**Results JSON:** `evals/experiments/2026-08-11_04-26-41pm_eval-openclaw-merged-prs-openclaw_e3a3fe.json`

**Headline: merged PRs produced the harness's first perfect trials — 8/8 assertions in 2 of 3 runs, content fully verified against the live oracle — and both tasks' sole remaining constraint is the 60-turn cap.** Token exhaustion, the failure mode of every previous medium trial, is gone: uncached input dropped from ~700k per run to ~120 tokens per run.

## Results

| Task | Accuracy | Completion | Task pass | Trial endings |
|---|---|---|---|---|
| Last 10 merged PRs (screenshots + CSV) | 70.8% (was 12.5%) | 2/3 (was 0/3) | ✗ | 2 completed (55, 60 turns); 1 `max_turns` |
| Top 30 contributors CSV | 14.3% (unchanged) | 0/3 | ✗ | 3 × `max_turns` at 60 |

Trials 1–2 of merged PRs passed every assertion: correct 10 PRs in the oracle's window, committer/merger matching the oracle per row, reviewer semantics right, a valid provenance-carrying PNG per PR, manifest hashes verified. Trial 3 was mid-collection at turn 60 with no CSV yet. All three contributors trials died the same way: list collected, then per-profile name/LinkedIn enrichment (~2 turns × 30 profiles) ran out the turn budget around rank 10–15.

## Per-trial metrics (new-semantics metrics.json)

| Trial | Status | Turns | Peak context | Uncached in | Cache read | Cache write | Wall | Real cost |
|---|---|---|---|---|---|---|---|---|
| PRs 1 (`…_4958a9`) | completed | 60 | 118,600 | 120 | 4.07M | 115k | 231s | $1.77 |
| PRs 2 (`…_9fe3c8`) | completed | 55 | 111,476 | 110 | 4.08M | 108k | 200s | $1.74 |
| PRs 3 (`…_23884f`) | max_turns | 60 | 135,615 | 120 | 4.42M | 132k | 240s | $1.93 |
| Contribs 1 (`…_cbc18b`) | max_turns | 60 | 123,497 | 120 | 3.91M | 120k | 228s | $1.72 |
| Contribs 2 (`…_998792`) | max_turns | 60 | 131,046 | 120 | 4.56M | 128k | 204s | $1.92 |
| Contribs 3 (`…_86c180`) | max_turns | 60 | 122,652 | 120 | 4.07M | 120k | 196s | $1.74 |

Cost weights: 1× input, 1.25× cache write, 0.1× cache read, 5× output ($3/M input basis). A 60-turn run now costs ~$1.80; uncached, the same run would be ~$12–14 of input alone. The old baseline paid ~$2.15 to die at 22–28 turns.

**Comparability warning:** `metrics.json` from commit `8d0ea98` onward is not comparable with earlier baselines. `budget_exceeded` now means per-request context (`context_budget`) or turns (`max_turns`), never cumulative tokens; `cacheCreationInputTokens` and `peakContextTokens` are new; cumulative sums are observability only. Compare depth across eras via `peakContextTokens` and cost via the four token sums. Trial latencies in this report's results JSON are replay latencies (~0ms) — read `wallClockMs` from each run's metrics.json instead.

## Mechanism verification (spec's checklist)

- **Moving breakpoint:** every turn N read exactly what turns 1..N−1 wrote (e.g. 3,137 written on turn 1 → 3,137 read on turn 2; reads grow monotonically to ~140k). Uncached input ~2 tokens/turn. Zero `cache_miss_warning` events across all trials (~350 turns) — the prefix never broke.
- **Context guard:** fired once across the day's attempts — peak 200,165 vs the 200,000 cap (`…_cd6465`, attempt 2) — the strict-greater boundary working exactly as specified. Peaks this attempt ran 111–136k, comfortably under 200k; the 200k default is right and `maxTurns` is the binding guard, as Step 0 projected.
- **Latency:** late turns return in ~2–4s (prefill skipped); 55–60-turn runs complete in 3–4 minutes.
- **Batch cap:** never triggered (inspect-heavy turns stayed under 200k combined) — present as a backstop.

## Eval-infra fragility (found, worked around, decision pending)

Three consecutive eval attempts crashed on transient failures, none in harness code: `fetch failed` during a grading-time oracle fetch (attempts 1 and 3), and an Anthropic `overloaded_error` (529) mid-stream (attempt 2). The runner grades all-or-nothing at the end, so each crash discarded the grading of every finished trial, and a mid-stream crash also skips `finish()` — no metrics.json for that run (`…_3181ed`).

- **Recovery shipped:** `evals/runners/regrade.ts` replays existing run directories through the unchanged `runEvals` grading path (oracles fetched fresh; graders still see only the run dir). This report's grades come from regrading attempt 3's six finished runs.
- **Candidate mechanism (user's decision, per the standing rule):** retry with backoff on transient failures — model calls (Claude Code retries 529s/connection errors; a mid-run crash currently loses the whole trial) and oracle fetches (one blip currently loses a whole eval's grading).

## Candidate next mechanisms (user's decision, per the standing rule)

1. **Raise `maxTurns`** (e.g. 60 → 90). The cheap experiment: merged PRs plausibly goes 3/3 (trial 3 needed a handful more turns) and contributors needs ~80–100 turns at its observed ~2 turns/profile rhythm. Cost is no longer a concern (~$3/run at 100 turns) and peak context at 90 turns projects to ~180k — still under the 200k guard, but close.
2. **Retry on transient failures** (above) — makes multi-run evals land reliably.
3. **Cheaper repeat-page representation** — the contributors rhythm (navigate → inspect → grep per profile) spends ~2 turns per rank; a delta-inspect or batched-profile approach would cut turn depth directly instead of raising the cap. More design work; attacks the actual constraint.

Attempt-1/2 runs (same code, crashed before grading) corroborate everything above: merged PRs completed 3 of 6 times there (47, 51, 58 turns) with full deliverables; contributors always hit the cap. Nine of the day's twelve measured runs at 60 turns say the turn cap, not judgment, is what stands between the harness and 2/2.
