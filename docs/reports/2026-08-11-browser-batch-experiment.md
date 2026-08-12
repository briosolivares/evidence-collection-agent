# Browser Batch A/B Experiment — Evidence-Collection Agent

**Date:** August 11, 2026 (runs started 2026-08-12T00:40:09Z)  
**Evaluated commit:** `a01dce677e2c593ffdaa01c3e9cf2a0ed8360491`  
**Headline:** Quality held at 9/9 completed trials in both conditions, but Claude called `browser_batch` in **0/9 treatment trials**. The extra schema added 1,244 first-request prompt tokens without compressing any browser calls. Keep `atomic` as the product default; leave batching opt-in and experimental.

This is a feature experiment with a fresh control, not a re-baseline. Both conditions used `claude-sonnet-5`, the same commit, system prompt, task packages, browser profile, guard defaults, and live graders/oracles.

## Conditions and order

- Control: `--tool-profile atomic` (the ten existing tools).
- Treatment: `--tool-profile batch-enabled` (the same ten tools plus `browser_batch`).
- Suite: `hacker_news,edgar,openclaw_pr`, `k=1` per invocation.
- Three balanced blocks: atomic → treatment; treatment → atomic; atomic → treatment.

Each invocation used:

```sh
npx tsx --env-file=.env evals/runners/cli.ts \
  --tasks hacker_news,edgar,openclaw_pr \
  --k 1 \
  --tool-profile <atomic|batch-enabled>
```

Analyzer command:

```sh
npm run analyze:browser-batch -- \
  --atomic <the three atomic result files, comma-separated> \
  --batch-enabled <the three treatment result files, comma-separated>
```

Before spending on the A/B, the main worktree passed 72 test files / 479 tests and `npm run typecheck`. A live treatment smoke completed in seven turns with hashed artifacts, 29,650 cache-read tokens, no cache-miss warning, and a matching Langfuse trace. The smoke also chose atomic calls, which was an allowed discovery result.

## Quality and adoption

| Condition | Assertion accuracy | Completed trials | Tasks passing at k=3 | Trials using batch | Batch calls | Batch errors |
|---|---:|---:|---:|---:|---:|---:|
| Atomic | 100% | 9/9 | 3/3 | 0/9 | 0 | 0 |
| Batch-enabled | 100% | 9/9 | 3/3 | **0/9** | **0** | 0 |

Treatment made 46 direct atomic browser calls, compared with 45 in control. With no nested operations, both conditions remained at 1.00 browser operation per model-visible browser call and treatment's batched-operation share was 0%. There was therefore no behavioral compression to evaluate.

## Efficiency

Values below are medians across each task's three trials. Weighted tokens are the experiment's normalized approximation: `input + 1.25 × cache creation + 0.1 × cache read + 5 × output`.

| Task | Condition | Turns | Wall clock | Weighted tokens | Peak context | Browser ops / visible calls |
|---|---|---:|---:|---:|---:|---:|
| Hacker News | Atomic | 5 | 19.0s | 36,739 | 22,770 | 6 / 6 |
| Hacker News | Batch-enabled | 5 | 18.7s | 37,513 | 23,943 | 6 / 6 |
| EDGAR | Atomic | 11 | 47.3s | 92,685 | 49,365 | 21 / 21 |
| EDGAR | Batch-enabled | 10 | 46.6s | 89,476 | 50,075 | 22 / 22 |
| OpenClaw PR | Atomic | 11 | 50.0s | 42,259 | 20,703 | 18 / 18 |
| OpenClaw PR | Batch-enabled | 11 | 46.6s | 42,040 | 21,057 | 18 / 18 |

Across all nine trials, overall medians were 11 versus 10 turns, 47.3s versus 44.3s wall clock, and 42,259 versus 42,040 weighted tokens for atomic and treatment respectively. Those small treatment-favorable differences cannot be attributed to batching because no batch was called; they are ordinary live-run variation. EDGAR treatment also performed one more browser operation overall.

All token-field medians:

| Condition | Uncached input | Output | Cache read | Cache creation | Peak context | Weighted |
|---|---:|---:|---:|---:|---:|---:|
| Atomic | 22 | 2,159 | 103,685 | 19,624 | 22,770 | 42,259 |
| Batch-enabled | 20 | 1,934 | 112,654 | 19,661 | 23,943 | 42,040 |

## Schema overhead

The model-facing tool definitions serialized to 5,280 bytes for atomic and 8,412 bytes for batch-enabled: **+3,132 bytes**. First-request prompt tokens increased from a median 3,091 to 4,335: **+1,244 tokens (40.2%)**. The per-task delta was identically 1,244 tokens because task text is unchanged between profiles. With zero adoption, the first experiment observed only this cost and no compensating turn reduction.

## Raw results

Block 1:

- Atomic: [`2026-08-11_05-42-17pm_..._befe47.json`](../../evals/experiments/2026-08-11_05-42-17pm_eval-hacker-news-edgar-openclaw-pr_befe47.json)
- Batch-enabled: [`2026-08-11_05-44-26pm_..._ab0181.json`](../../evals/experiments/2026-08-11_05-44-26pm_eval-hacker-news-edgar-openclaw-pr_ab0181.json)

Block 2:

- Batch-enabled: [`2026-08-11_05-46-45pm_..._02cfc3.json`](../../evals/experiments/2026-08-11_05-46-45pm_eval-hacker-news-edgar-openclaw-pr_02cfc3.json)
- Atomic: [`2026-08-11_05-49-19pm_..._5db1d1.json`](../../evals/experiments/2026-08-11_05-49-19pm_eval-hacker-news-edgar-openclaw-pr_5db1d1.json)

Block 3:

- Atomic: [`2026-08-11_05-51-38pm_..._b1fddb.json`](../../evals/experiments/2026-08-11_05-51-38pm_eval-hacker-news-edgar-openclaw-pr_b1fddb.json)
- Batch-enabled: [`2026-08-11_05-53-44pm_..._7b1553.json`](../../evals/experiments/2026-08-11_05-53-44pm_eval-hacker-news-edgar-openclaw-pr_7b1553.json)

Each result file contains its three absolute run-directory paths. Those 18 directories retain the complete manifests, artifacts, transcripts, and metrics used by the analyzer.

## Failures, limitations, and decision

There were no grader failures, run failures, budget exits, batch errors, or invalid environmental blocks, so no block was retried and no baseline failure-log entry was needed. Live data changed during the experiment: the newest OpenClaw PR advanced from #122359 to #122360 and then #122362; the grader's live-window rule handled that drift.

The sample is directional (`k=3` per task), not statistically powered, and the easy suite is saturated on quality. More importantly, zero adoption means this A/B tested discoverability from the tool description, not batching's theoretical execution value. The observed efficiency differences are not a batching effect.

**Rollout decision:** keep `DEFAULT_TOOL_PROFILE = 'atomic'`. `browser_batch` remains available only through the explicit `batch-enabled` profile. If batching is pursued further, specify a separate prompt-guided treatment; do not reinterpret or overwrite this description-only result.

## Possible follow-ups

Treat each as a separately specified intervention so its effect is distinguishable from this description-only A/B:

- Revise the system prompt to make ordered multi-action browser sequences discoverable and state when they are preferred.
- Revise the composite tool definition and schema to clarify its affordance while reducing unnecessary prefix overhead.
- Rename `browser_batch` to `browser_sequence`, which may better communicate ordered, sequential execution than “batch.”
- Explore richer programmable browser primitives beyond a fixed action list, while preserving validation, provenance, confinement, and the no-shell security boundary.
