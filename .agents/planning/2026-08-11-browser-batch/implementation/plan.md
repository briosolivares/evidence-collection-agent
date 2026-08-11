# Browser Batch Implementation and Experiment Plan

## Checklist

- [x] Step 1: Implement and verify the isolated `browser_batch` tool
- [x] Step 2: Add deterministic tool profiles and wire every composition point
- [ ] Step 3: Add eval condition metadata and the experiment analyzer
- [ ] Step 4: Verify the complete feature and run a local live smoke test
- [ ] Step 5: Run the easy-suite A/B experiment and publish the report
- [ ] Step 6: Make and record the rollout decision

Each verified step ends with a scoped commit. Update this checklist and include the planning directory in that commit, per repository workflow.

## Step 1: Implement and verify the isolated `browser_batch` tool

**Objective:** Add a normal `ToolDef` that composes the seven existing browser tools without registering it in production yet.

**Implementation guidance:**

- Create `src/tools/browserBatch/browserBatch.ts` and co-located tests.
- Build a top-level strict object schema with an `actions` array of 1–10 nested variants. Each variant has `{ tool, input }` and reuses the matching atomic tool's `inputSchema`.
- Build a restricted atomic browser registry in stable order: `navigate`, `inspect_page`, `click`, `type`, `scroll`, `screenshot`, `download`.
- Mark the tool `readOnly: false`.
- Execute nested calls sequentially through `executeToolCall` with deterministic internal IDs.
- Aggregate exact normalized action contents on success. On the first nested error, stop and throw a concise error naming its position/tool, completed count, nested error, and no-rollback rule.
- Export the tool and its public input/result types from `src/tools/index.ts`, but do not add it to the production registry yet.

**Test requirements:**

- Start with schema and pure executor tests: empty/oversized batches rejected, unsupported tools rejected, nested atomic inputs validated, strict unknown keys rejected, action order preserved, outputs remain ordered.
- Verify first-error stop semantics and that later actions never execute.
- Use the browser fixture helper for one `type → click → inspect_page` call and a stale-ref failure.
- Verify a batched evidence action still writes through the manifest chokepoint with source provenance.
- Verify large nested and aggregate results use the existing offload behavior.
- Verify `toApiToolDefs` produces a top-level object schema and repeated serialization is byte-identical.

**Integration with previous work:** The tool uses existing definitions, `ToolCtx`, `executeToolCall`, `capResult`, browser helpers, and evidence tools unchanged. No loop, scheduler, controller, tracing, prompt, or eval code changes in this step.

**Demo:** Invoke `browser_batch` through `executeToolCall` against the loopback fixture with one call that types into the textbox, clicks the announce button, and ends with `inspect_page`; show the returned final outline contains both the typed value and `Ready`.

## Step 2: Add deterministic tool profiles and wire every composition point

**Objective:** Make the treatment selectable without duplicating or drifting model-facing and runtime registries.

**Implementation guidance:**

- Add `ToolProfile = 'atomic' | 'batch-enabled'` and a shared `createProductionRegistry(profile)` builder near the tool index/registry boundary.
- Preserve the exact current order for `atomic`; append `browser_batch` for `batch-enabled`.
- Add `toolProfile?: ToolProfile` to `RunTaskConfig`, defaulting to `atomic`.
- Replace the hand-built registry in `runTask` with the shared builder.
- Update the TUI run-session bridge to build API tool definitions with the same selected profile and forward that profile into `runTask`; thread the option through TUI runtime config.
- Add a `browser_batch` semantic line (`Running N browser steps`) and evidence classification when any nested action is `screenshot` or `download`.
- Keep `SYSTEM_PROMPT` unchanged.

**Test requirements:**

- Assert the atomic profile's names/order are exactly the current ten tools.
- Assert the batch-enabled profile is the atomic list plus final `browser_batch`.
- Assert both profiles are deterministic across independent builds and every schema has a top-level object.
- Extend `runTask` scripted-model tests: atomic default rejects/does not advertise the batch tool; explicit treatment executes it and records exactly one call/result transcript pair.
- Extend TUI bridge tests so its API definitions and `runTask` config always use the same profile.
- Extend semantic renderer tests for count, fallback input, and evidence classification.
- Re-run prompt-cache tests to prove each fixed profile is stable across histories; do not require the two different profiles to share a cache key.

**Integration with previous work:** Step 1's isolated tool becomes reachable only through the explicit treatment profile. The atomic default provides a regression-safe control and leaves current REPL/TUI behavior unchanged.

**Demo:** Run two scripted `runTask` calls: the default model tool list/runtime registry contains ten atomic tools, while `batch-enabled` contains eleven and successfully executes a batch. Print only tool names and transcript event types—never environment secrets.

## Step 3: Add eval condition metadata and the experiment analyzer

**Objective:** Make both conditions reproducible and report behavioral/efficiency effects without changing graders.

**Implementation guidance:**

- Extend eval CLI parsing with required-explicit-for-experiment `--tool-profile atomic|batch-enabled`; retain `atomic` as the general CLI default.
- Pass the selected profile through the CLI's `runTask` closure.
- Add `toolProfile` to `EvalReport` and the formatted header/result JSON so files cannot be confused later.
- Add a pure analyzer under `evals/analysis/` that accepts one or more result JSON files per condition, follows their run directories, and reads `metrics.json` plus transcript events after grading.
- Count browser operations as direct atomic browser calls plus nested `browser_batch.actions`. Count model-visible browser calls as direct atomic calls plus outer batch calls. Derive batched-operation share and operations per visible call.
- Treat an errored outer `browser_batch` result as a batch failure. When a result was offloaded, follow its run-relative offload path through safe run-path handling rather than assuming the preview is complete.
- Report per-trial raw values and per-task/condition medians or means. Include all token fields, peak context, turns, wall clock, and an explicitly labeled approximate weighted-token cost.
- Keep analysis separate from grading: do not change task graders or pass them transcript paths.

**Test requirements:**

- CLI tests for defaults, both valid profiles, invalid values, and report formatting.
- Runner/report tests proving the selected profile is persisted.
- Analyzer fixtures covering direct atomics, successful batches, failed batches, mixed direct/batch use, offloaded results, missing optional legacy metric fields, and aggregation across three k=1 blocks.
- A grader-isolation regression test continues to prove graders receive only `(runDir, oracleData)`.

**Integration with previous work:** Step 2 selects the runtime/tool surface; this step labels it and computes adoption/efficiency from existing durable run records. It does not affect agent behavior.

**Demo:** Feed synthetic atomic and batch-enabled eval reports/transcripts into the analyzer and render a comparison containing quality, adoption, compression, turns, tokens, and latency.

## Step 4: Verify the complete feature and run a local live smoke test

**Objective:** Establish that the implementation is mechanically safe before spending on the A/B.

**Implementation guidance:**

- Run the full hermetic suite and typecheck from the worktree.
- Inspect the generated JSON schemas for both profiles without printing secrets.
- Run one real-model, headed-Chrome smoke task designed to have a stable, obvious batch opportunity. Use `.env` only through `npx tsx --env-file=.env`; never read or print values.
- Confirm the smoke run's manifest, transcript, metrics, and Langfuse trace: one outer batch call/result if Claude adopts it; normal atomic behavior is also a valid smoke outcome because adoption is an experiment question.
- Fix only general defects discovered by the smoke. Do not tune to an eval task and do not add prompt language before the first A/B.

**Test requirements:**

- `npm test`
- `npm run typecheck`
- Focused schema/profile tests may also be run first for fast feedback.
- Verify cache reads from turn 2 and absence of `cache_miss_warning` in the live transcript.

**Integration with previous work:** This is the first end-to-end check of the Step 1 tool, Step 2 profiles, and Step 3 observability on the exact code to be evaluated.

**Demo:** Show the smoke run directory and a redacted summary of tool names/action counts, artifacts, turns, and cache status.

## Step 5: Run the easy-suite A/B experiment and publish the report

**Objective:** Measure natural batch adoption, quality non-regression, and efficiency on fresh control and treatment runs.

**Implementation guidance:**

- Use exactly `hacker_news,edgar,openclaw_pr`.
- Collect three trials per task per condition (18 total runs) from the same verified commit, model, browser profile, prompt, task packages, and guard defaults.
- Balance time/order effects with three k=1 blocks, alternating condition order:

  1. atomic, then batch-enabled;
  2. batch-enabled, then atomic;
  3. atomic, then batch-enabled.

- Each invocation uses:

  ```sh
  npx tsx --env-file=.env evals/runners/cli.ts \
    --tasks hacker_news,edgar,openclaw_pr \
    --k 1 \
    --tool-profile <atomic|batch-enabled>
  ```

- Preserve every result JSON and run directory. Do not edit or retry a trial selectively. If an environmental failure invalidates a block, document it and rerun the entire paired block.
- Run the analyzer across the three result files for each condition.
- Write `docs/reports/2026-08-11-browser-batch-experiment.md` with commit, commands/order, raw result paths, quality, adoption, per-task efficiency, failures, schema overhead, and limitations.
- Update the implementation checklist and, if any genuine eval failure analysis is needed, the active planning failure log. Do not call this a re-baseline; it is a feature experiment with a fresh control.

**Evaluation questions:**

1. Does treatment retain 9/9 grader completion and 3/3 task pass?
2. In how many treatment trials does Claude call `browser_batch` at least once?
3. What share of browser operations are nested in batches, and how many actions occur per outer batch?
4. Does adoption reduce model turns, especially on EDGAR/OpenClaw action-to-inspection sequences?
5. What happens to total/weighted tokens, peak context, wall-clock time, and batch error recovery?
6. How much first-request prefix overhead does the extra schema add?

**Interpretation:** k=3 supports a directional engineering decision, not statistical significance. Quality regression blocks rollout. Low adoption means the unguided affordance was not discovered reliably; it does not prove batching cannot help. If a prompt-guided condition is wanted, specify and run it separately so the first A/B remains attributable.

**Integration with previous work:** The existing eval runner/oracles/graders remain the source of quality truth. Step 3 adds only condition labels and post-grade operational analysis.

**Demo:** Present the comparison report and link every underlying result JSON/run directory so another engineer can reproduce each aggregate.

## Step 6: Make and record the rollout decision

**Objective:** Convert experiment evidence into an explicit product default without conflating implementation and evaluation.

**Implementation guidance:**

- If batch-enabled has no quality regression and produces meaningful adoption with a favorable or neutral efficiency tradeoff, change the product default to `batch-enabled` in a small standalone commit and update relevant docs/tests.
- If adoption is low, keep `atomic` as default and decide whether to run a separately specified prompt-guided treatment.
- If adoption is substantial but causes errors or no efficiency gain, keep the tool experimental while using transcripts to identify a general contract problem; do not add task-specific behavior.
- Record the decision and rationale in the experiment report and handoff state.

**Test requirements:** Any default flip must update default-behavior tests, rerun `npm test` and `npm run typecheck`, and verify the TUI/model/runtime surfaces still match.

**Integration with previous work:** This step changes only rollout policy based on Step 5 evidence; the atomic profile remains available for continued measurement and rollback.

**Demo:** Start a default run and show which deterministic tool profile it advertises, plus the command that still selects the alternative profile.
