# Retry on Transients + maxTurns Off — Easy & Medium Re-Run

**Date:** August 11, 2026 (runs 2026-08-12T01:02–01:42Z, each suite graded at its end)
**Changes under test:** `.agents/planning/2026-08-11-retry-mechanism/spec.md`, commit `fced2f7`: Part A oracle-fetch retry (`fetchWithRetry` in `githubGetJson`), Part B model-call retry over stream creation *and* consumption (SDK `maxRetries: 0`, 4 attempts, 1/2/4s ±50% jitter), Part C metrics-on-crash bookkeeping — plus `maxTurns` off by default (60 → `Infinity`; the 200k per-request context ceiling is the sole terminating guard).
**Commands:** `npx tsx --env-file=.env evals/runners/cli.ts --tasks hacker_news,edgar,openclaw_pr --k 3`, then `--tasks openclaw_merged_prs,openclaw_contributors --k 3` (sequential; shared Chrome profile).
**Results JSON:** easy `evals/experiments/2026-08-11_06-09-19pm_eval-hacker-news-edgar-openclaw-pr_95646e.json`; medium `evals/experiments/2026-08-11_06-42-21pm_eval-openclaw-merged-prs-openclaw_0e2b3f.json`

**Headline: the harness's first crash-free full-evening eval — both suites ran end-to-end, graded in-process, no regrade needed — and the first uncapped runs: merged PRs delivered a fully verified 8/8 trial at 76 turns and contributors finished its 30-row CSV in all three trials at 85–94 turns, work the old 60-turn cap would have killed.** The easy suite stays saturated at 3/3, 100%. Medium is still 0/2 on the strict bar, but the three remaining failure modes are now sharply separated: one context-ceiling exhaustion, one oracle-freshness churn miss, and one deterministic page-vs-API ranking gap. The retry paths themselves went unexercised — zero transients occurred in ~470 turns and eight oracle fetch groups.

## Results

| Task | Accuracy | Completion | Task pass | Trial endings |
|---|---|---|---|---|
| hacker_news | 100% | 3/3 | ✓ | 3 completed (4 turns each) |
| edgar | 100% | 3/3 | ✓ | 3 completed (11–12 turns) |
| openclaw_pr | 100% | 3/3 | ✓ | 3 completed (11–12 turns) |
| Last 10 merged PRs (screenshots + CSV) | 66.7% (was 70.8%) | 1/3 | ✗ | 2 completed (57, 76 turns); 1 `context_budget` at 59 |
| Top 30 contributors CSV | 85.7% (was 14.3%) | 0/3 | ✗ | 2 completed (93, 94 turns); 1 `context_budget` at 85 |

Easy-suite mean latencies: 17.9s / 53.0s / 56.5s. No easy trial came near any guard (deepest: 12 turns, well under 200k context); the retry/maxTurns changes are regression-free there.

Medium detail: merged-PRs trial 3 passed all 8 assertions — correct 10 PRs in the oracle window, committer/merger oracle-matched per row, reviewer semantics right, a provenance-carrying PNG per PR, hashes verified — at 76 turns, past the old cap. Trial 1 scored 7/8, failing only the freshness window (below). Trial 2 hit the context ceiling before writing its CSV (1/8: only manifest hashes). All three contributors trials scored an identical 6/7: complete, well-formed 30-row CSVs with verified names and shape-valid LinkedIn URLs, failing only the top-40 membership assertion, identically (below).

## Per-trial metrics (medium)

| Trial | Status | Turns | Peak context | Uncached in | Cache read | Cache write | Wall | Real cost |
|---|---|---|---|---|---|---|---|---|
| PRs 1 (`…_b5b4c2`) | completed | 57 | 177,373 | 114 | 4.51M | 173k | 226s | $2.12 |
| PRs 2 (`…_4759be`) | context_budget | 59 | 213,018 | 118 | 4.98M | 209k | 253s | $2.41 |
| PRs 3 (`…_dd29e7`) | completed | 76 | 177,605 | 152 | 8.04M | 173k | 333s | $3.24 |
| Contribs 1 (`…_5bd6ca`) | context_budget | 85 | 200,731 | 170 | 9.00M | 197k | 327s | $3.56 |
| Contribs 2 (`…_4f4ff5`) | completed | 93 | 193,675 | 186 | 9.15M | 189k | 384s | $3.60 |
| Contribs 3 (`…_4fc702`) | completed | 94 | 196,684 | 188 | 9.67M | 193k | 385s | $3.76 |

Cost weights as in the medium re-baseline: 1× input, 1.25× cache write, 0.1× cache read, 5× output ($3/M input basis). A 90+-turn run costs ~$3.60–3.80; the caching mechanism is what makes uncapped depth affordable (uncached input stayed at ~2 tokens/turn — 114–188 per run). Zero `cache_miss_warning` events across both suites; the prefix never broke.

## Mechanism verification

- **Crash-free evals (the spec's live criterion):** "next multi-trial eval lands without a regrade" — met. Both suites completed and graded in-process on the first attempt, versus three consecutive crashed attempts in the medium re-baseline session. Weak evidence in one sense (no transients occurred to be retried) but the outcome the mechanism exists to protect is what the evening produced.
- **Retry loops (Parts A, B): unexercised.** Zero `retry` progress events across all 15 trials (~470 turns) and zero oracle-fetch retries across both grading passes. No 529s, no dropped streams, no fetch failures tonight. The paths remain covered by the unit suite only.
- **Part C (metrics on crash): unexercised.** No run crashed. (The two `budget_exceeded` runs wrote metrics via the ordinary `finish()` path, as they always did — they do not exercise Part C.)
- **maxTurns off:** the change did exactly what it was for. Five of six medium trials ran past the old 60-turn cap or died at its brink for a different reason; every trial that got past 60 produced its complete deliverable set. The re-baseline's projection — "contributors needs ~80–100 turns at its ~2 turns/profile rhythm" — landed dead center (85–94 observed).
- **Context ceiling as the terminating guard:** fired 2 of 6, at peaks 213,018 and 200,731 vs the 200k cap. Termination is real. Note the guard is post-hoc per request — a single heavy turn overshot by 13k before the check caught it — so "200k" in practice means "200k plus one turn's growth."

## Failure analysis — three separated modes

### M1. Contributors page-vs-API ranking gap (contributors, 3/3 trials, deterministic)

All three trials failed the same assertion the same way: **22 of 30 CSV handles found in the oracle's top 40, needing ≥25** — with the *identical* eight missing handles each time (`claude`, `cursoragent`, `openclaw-clownfish[bot]`, `turbotheturtle`, `hugenshen`, `masatohoshino`, `zenglingbiao`, `vyctorbrzezowski`). The agent reads the website's contributors graph (which ranks bot/app identities like `claude` and `cursoragent` among the top 30); the oracle ranks via the REST API. The grader design anticipated exactly this ("window 40, tolerance ≥25 of 30 — absorbs bot-filtering and ranking-edge disagreements", `medium-tasks.md`) — the real disagreement is simply larger than the tolerance budgeted for it. The agent's execution is not in question: rank order was scraped and preserved as evidence, all 30 profiles were visited, names verified, no LinkedIn URLs guessed. **This is an eval-design gap, not an agent defect** — resolving it (bot filtering on both sides, wider window, or aligning the ranking source) is a grader/oracle decision, not an agent mechanism.

### M2. Oracle freshness churn (merged PRs, trial 1)

Trial 1 captured PRs #122330–122358 at 01:09–01:13Z; grading ran after all six trials at ~01:35Z, and by then the oracle's 30-PR recently-merged window no longer contained **#122330** — the repo merged roughly 30 PRs in the ~25-minute gap (PR numbers observed climbing 122319 → 122364 across the evening). The window is already 3× the task's 10 to absorb churn; on a repo this hot, sequential-suite grading latency can outrun it. The run was correct at run time. Candidate fixes are eval-infra: grade each trial immediately after it completes (per-trial grading instead of end-of-suite), widen the window further, or timestamp-anchor the oracle window to the trial's end time.

> **Correction (2026-08-11, later the same night):** the mechanism above is wrong. The runner has graded **per-trial since T17** — each trial's oracle is fetched immediately after its `runTask` returns (`evals/runners/runner.ts`), so trial 1 was graded at ~01:13Z, roughly **4 minutes** after its listing was captured, not 25. The churn conclusion stands and gets starker: #122330 fell out of the 30-entry updated-closed window within minutes (the window's `sort=updated` proxy moves on *any* closed-PR update — bot comments and labels included — not just merges). "Grade sooner" is therefore not an available fix; the remaining levers are eval-design: widen the window, snapshot the oracle at run start (a Tier-A semantics change), or accept occasional churn misses on hot repos. What earlier docs' "grades all-or-nothing at the end" actually described is **persistence**: grades lived only in process memory until the end-of-suite results write, so a crash discarded every finished trial's grading — that gap is now closed by per-trial partial persistence (`onTrialGraded` + a partial JSONL, removed once the final results JSON lands).

### M3. Context-ceiling exhaustion before artifact (merged PRs, trial 2)

Trial 2 spent its 200k context by turn 59 while still exhaustively verifying merge timestamps against a cutoff — no CSV yet written, so 1/8. Same verdict as every budget death before it: out of room, not out of judgment. Two general-mechanism directions carry over from the re-baseline report: (a) **cheaper repeat-page representation** — the navigate → inspect → grep rhythm re-pays for similar page structure dozens of times; a delta-inspect or terser repeat-visit representation attacks context growth directly; (b) **artifact-early behavior** — a prompt-level norm to write deliverables incrementally as data lands (contributors trial 1 survived its ceiling death at 6/7 precisely because its CSV was already on disk; merged-PRs trial 2 died with everything in context and nothing on disk).

## Candidate next mechanisms (user's decision, per the standing rule)

1. **Fix the contributors grader/oracle mismatch (M1)** — eval-design change: filter bot/app accounts symmetrically, widen the window, or switch the oracle's ranking source to match what the site shows. Cheapest path to a truthful contributors signal; today's 6/7s are measuring the oracle, not the agent.
2. **Per-trial grading (M2)** — grade each run right after it finishes instead of after the whole suite; also shrinks the blast radius of any grading-time failure (compounds with Part A's retry). *(Correction: grading was already per-trial — see the M2 correction above. Superseded by per-trial partial persistence, since implemented; the freshness lever that remains is a window/oracle-timing decision.)*
3. **Artifact-early prompt norm (M3b)** — general, cheap, and the data already shows it separating 6/7 from 1/8 at ceiling death.
4. **Cheaper repeat-page representation (M3a)** — the deep fix for context economy; more design work, attacks the actual constraint for merged-PRs-shaped tasks.

## What held up (worth recording)

- Provenance: manifest hashes verified 15/15 trials.
- Prompt caching: ~2 uncached input tokens/turn at 90+ turns; zero cache-miss tripwires.
- Judgment at depth: uncapped agents did not wander — turns 60–94 were spent on systematic per-item verification (PR timestamps, per-profile name/LinkedIn checks), not loops or drift.
- The eval infrastructure end-to-end: two suites, 15 trials, 8 oracle fetch groups, zero crashes, zero manual recovery — first time since medium work began.
