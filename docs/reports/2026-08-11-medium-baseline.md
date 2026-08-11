# Medium-Task Baseline Report — Evidence-Collection Agent

**Date:** August 11, 2026 (run started 2026-08-11T08:47:40Z)
**Command:** `npx tsx --env-file=.env evals/runners/cli.ts --tasks openclaw_merged_prs,openclaw_contributors --k 3`
**Headline: 0 of 2 tasks passed — all six trials died `budget_exceeded` on the 250k token ceiling before writing their CSV.** This is one failure mode, not many: the agents were working correctly and ran out of conversation budget, exactly the outcome the cap was deliberately kept to measure.

Task packages: built this session (commit `7972b1c`), design rows 6 and 8. Full per-assertion detail: `evals/experiments/2026-08-11_01-53-51am_eval-openclaw-merged-prs-openclaw_4e2a7f.json`.

## Results

| Task | Accuracy | Completion | Task pass | Mean latency | Trial endings |
|---|---|---|---|---|---|
| Last 10 merged PRs (screenshots + CSV) | 12.5% | 0/3 | ✗ | 75s | token ceiling at 13–18 turns, 210–229k |
| Top 30 contributors CSV | 14.3% | 0/3 | ✗ | 45s | token ceiling at 11–12 turns, 225–241k |

The only passing assertion anywhere was the standing manifest-hash check (6/6 — provenance held again). Every content assertion failed downstream of "no CSV artifact exists," so per-assertion accuracy is uninformative this round; the graders worked as designed but had no deliverable to grade.

## The single failure mode: token budget, not judgment

- **The 24-turn budget never bound** (max observed: 18 turns). The 250k cumulative token ceiling bound 6/6 — it counts `input + output + cache_read` per response, and only the ~3k prompt prefix caches, so each late turn re-pays the whole growing conversation at 20–35k tokens.
- **Merged PRs:** trials 1 and 3 died mid-execution with 2 of 10 PR screenshots captured (`screenshots/pr_121955.png`, `pr_121957.png`); trial 2 died still building its PR list notes. Working rhythm per PR ≈ navigate → inspect → screenshot ≈ 2–3 turns ≈ 40–70k tokens; ten PRs plus list-building needs roughly 3× the ceiling.
- **Contributors:** GitHub's contributors graph lazy-loads on scroll, so the agent looped scroll → re-inspect → grep the offloaded outline, reaching ~rank 20 of 30 when the ceiling hit. Zero artifacts landed in two of three trials.
- Transcripts show sound judgment throughout — correct pages, correct data extraction, sensible handling of lazy-loading. The agents ran out of tokens, not ideas (the same verdict as the easy baseline's F3, one level up).

## What held up

- **Provenance:** manifest hashes verified 6/6, including partial-progress artifacts.
- **GitHub token path:** oracles fetched fresh ground truth for all six gradings with zero rate-limit trouble (authenticated at 5,000/hr).
- **Fail-fast graders:** every failure detail names its cause; no false passes on runs that produced nothing.

## Candidate general mechanisms (user's decision, per the standing rule)

1. **Conversation-depth prompt caching** — move a cache breakpoint with the conversation (as Claude Code does) instead of caching only the static prefix. Cuts real per-turn cost ~10× on deep runs. Note the interplay: the budget currently counts cache reads, so caching alone doesn't extend runs — it needs (2a) or a raised cap to matter for completion.
2. **Redefine the token budget as a cost guard** — count only uncached input + output (2a), and/or **raise the ceiling** for medium tasks (2b; the data says ~3× is the natural scale for row 6). (2b) alone is the cheapest experiment: it answers "do the tasks pass given room?" in one re-run.
3. **Cheaper repeat-page representation** — the contributors pattern (scroll, full re-inspect, grep) re-pays a heavy page repeatedly; an inspect variant that returns only what changed since the last inspect would collapse that loop's cost. More speculative; design work needed.

Recommended sequencing: (2b) alone first to measure true task depth, then decide (1)+(2a) as the durable fix with real numbers in hand.
