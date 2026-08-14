# Output-contract protocol (v2 registry): does it improve latency?

**Date:** 2026-08-14 (midday)
**Model:** claude-sonnet-5 · tool profile `atomic` · concurrency 3 (headless isolated)
**Branch/commit under test:** `feat/judge-harness` @ `0911e03`
**Command:** `npm run evals -- --tasks hacker_news,edgar,openclaw_merged_prs --k 1 --concurrency 3 --output-contract`
**Protocol:** typed output contract, authored by the initializer (`--output-contract`, default `contractAuthor=initializer`) — contract-first gate, typed rows via `upsert_output_rows`/`set_table_completeness`, `submit_for_verification` gate — contrasted with the prose INTENT.md/CONTRACT.md path that is still production's default
**Results JSON:** `evals/experiments/2026-08-14_10-46-20am_eval-hacker-news-edgar-openclaw-merged_615db4.json`

A representative 3-task subset (`hacker_news`, `edgar`, `openclaw_merged_prs`) was run once each (k=1) under the typed output-contract protocol to check whether it's faster than the prose protocol measured in [`2026-08-14-judge-harness-k2-latency-and-account-creation-incident.md`](./2026-08-14-judge-harness-k2-latency-and-account-creation-incident.md). Headline: **all 3/3 tasks passed clean (100% accuracy each)**, but latency is **mixed, not a clear improvement** — one task got faster, two got slower.

## Results

| Task | Accuracy | Latency (this run) | Run dir |
| --- | --- | --- | --- |
| hacker_news | 6/6 | 38.4s | `runs/2026-08-14_10-35-01am_create-a-csv-of-the-top-5-stories-on_ffeadc` |
| edgar | 3/3 | 78.7s | `runs/2026-08-14_10-35-01am_find-apple-s-8-k-filing-from-january-29_e9c208` |
| openclaw_merged_prs | 8/8 | 680.1s | `runs/2026-08-14_10-35-01am_collect-evidence-about-the-last-10_a9c774` |

## Latency vs the prose protocol (latest report, k=2 means)

| Task | Prose (k=2 mean) | Output-contract (this run, k=1) | Δ |
| --- | --- | --- | --- |
| hacker_news | 31.3s | 38.4s | 1.23× slower |
| edgar | 101.3s | 78.7s | **0.78× — 22% faster** |
| openclaw_merged_prs | 517.7s | 680.1s | 1.31× slower |

Only `edgar` improved. `hacker_news` and `openclaw_merged_prs` were both slower under the output-contract protocol.

## Why openclaw_merged_prs got slower: two rejected submissions

Per-trial role breakdown from `metrics.json` (`wallClockMs`, agent-internal time only — the eval report's latency figure above also includes browser setup/queueing overhead on top of this):

| Task | initializer | worker | verifier | worker+verifier turns |
| --- | --- | --- | --- | --- |
| hacker_news | 3.2s | 22.0s | 8.4s | 5 / 2 |
| edgar | 7.6s | 44.8s | 13.8s | 13 / 3 |
| openclaw_merged_prs | 9.2s | 378.3s | 167.5s | 85 / 26 |

`openclaw_merged_prs` called `submit_for_verification` three times — turn 72 and turn 77 were both rejected by the gate, sending the worker back to fix rows via `upsert_output_rows`/`set_table_completeness` before a third submission at turn 85 finally passed. That's a full extra round-trip of worker+verifier work compared to a single-pass gate, and it accounts for most of the verifier's unusually high 26 turns / 167.5s (vs. single-digit turns and under 15s for the other two tasks).

## Caveat: this is not a robust comparison

This run is **k=1 per task**, compared against the prior report's **k=2 means**. A single trial per task is a noisy sample — the openclaw_merged_prs slowdown could be this run drawing an unlucky rejection cycle rather than a systematic property of the output-contract protocol, and the edgar improvement is equally unproven at n=1. Before concluding the output-contract protocol is faster, slower, or a wash, it needs a real head-to-head: same task set, same k (2 or 3), both protocols, ideally in the same batch window to control for model/infra variance.

## What this run does show

- **The typed-contract path works end-to-end** on all three tasks, including the two-lane distinction (headless isolated for all three here) and the verifier-rejection retry loop — a rejected `submit_for_verification` correctly routes back to the worker rather than stalling or silently passing.
- **Accuracy held at 100%** across all three tasks and matched the prose protocol's clean results on the same tasks from the k=2 run.
- **No latency win demonstrated yet.** The two-of-three regression suggests the contract-first gate's own back-and-forth (typed row upserts, completeness checks, submission retries) can add real time when the gate rejects, and that cost isn't yet shown to be offset by less exploratory prose reasoning elsewhere in the worker loop.
