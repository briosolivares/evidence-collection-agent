# Spec: Moving cache breakpoint + per-request context guard

**Date:** 2026-08-11 · **Status:** agreed, not yet implemented
**Motivated by:** `docs/reports/2026-08-11-medium-baseline.md` — 0/2 medium tasks, all six trials `budget_exceeded` on the 250k cumulative token ceiling at 11–18 turns. Runs had sound judgment and ~20–35k of *per-request* context at death; the cumulative ceiling double-counts history every turn and conflates cost, context, and turn depth.
**Mechanism provenance (general, Claude Code–borrowed):** moving message breakpoint = `addCacheBreakpoints` (`claude-code/src/services/api/claude.ts:3063`, marker on last message, clone-don't-mutate at `:622`); per-request context measure = `getTokenCountFromUsage` + `tokenCountWithEstimation` (`claude-code/src/utils/tokens.ts:46,226` — its docstring explicitly warns against cumulative counting, "which double-counts as context grows"); batch cap = `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` (`claude-code/src/constants/toolLimits.ts:49`); tripwire = `promptCacheBreakDetection.ts`.

## Sequencing (agreed)

1. **Step 0 — experiment 2b first (no semantics change):** raise the *existing cumulative* ceiling to measure true task depth before any code redesign. The eval runner has no budget flags — temporarily bump `DEFAULT_MAX_TOKENS` in `src/cli/runTask.ts` (250_000 → **750_000**, the report's ~3× estimate) **and** `maxTurns` default (24 → **60**; row 6 plausibly needs 30–40 turns at 2–3/PR, and with more token room the turn guard will bind next). Re-run:
   `npx tsx --env-file=.env evals/runners/cli.ts --tasks openclaw_merged_prs,openclaw_contributors --k 3`
   Record the report (`docs/reports/`). This answers "do the tasks pass given room?" and calibrates the new guard numbers.
   **✅ Done 2026-08-11 — see `docs/reports/2026-08-11-medium-ceiling-raise.md`.** 0/2 again; all six trials `budget_exceeded` at 22–28 turns, ~768–802k cumulative. 3× ceiling → only ~1.7× turns (√-scaling confirmed: the cumulative measure is quadratic in turns). True task depth ≈ 50–70 turns; peak per-request context 46–84k, growing ~3k/turn → ~150–220k at completion depth. Turn cap 60 never bound; keep it.
2. **Step 1 — implement Parts 1–4 below.**
3. **Step 2 — re-baseline at k=3**, report with the new metrics (see Reporting note).

## Part 1 — Moving conversation cache breakpoint

`src/model/callModel.ts` (`buildRequestParams`):
- Keep the existing `cache_control` breakpoint on the single system block (caches tools + system; unchanged).
- Add `cache_control: {type: 'ephemeral'}` to the **last content block of the last message**, on every request. **Clone the message and block — never mutate** `state.messages` (the loop owns it; the transcript logs it live). All earlier messages pass through untouched.
- Result: exactly **2 breakpoints per request** (API max 4). One message-level marker only, matching Claude Code (server-side KV page-eviction reasons; a second marker pins pages nothing resumes from).
- No thinking blocks exist (thinking disabled) so no skip logic; text / tool_use / tool_result all accept markers.
- Prefix minimum to cache on claude-sonnet-5 is **1,024 tokens**; our tools+system prefix is ~3k — fine.
- Doc-comment caveat (no code): server cache lookback is 20 content blocks; a single turn adding >20 blocks would silently miss. Our turns add 2 messages with ≤ ~12 blocks (5-parallel cap) — documented, not guarded.

Usage plumbing:
- `src/loop/messages.ts` — `Usage`: add `cache_creation_input_tokens?: number | null` (currently dropped; after this change every turn's newly cached extension lands there).
- `src/model/streamAssembly.ts`: capture `cache_creation_input_tokens` from `message_start` / `message_delta` (same pattern as the existing `cache_read` handling).
- `src/tracing/runTracing.ts` (~line 136) and `src/cli/replFormat.ts` (usage line): surface the new field.

Expected economics: turn N reads all history at ~0.1× (`cache_read`), pays 1× on the new turn, ~1.25× write on the extension. ~10× real-cost cut on deep runs; big latency drop on late turns (prefill skipped).

## Part 2 — Per-request context guard (replaces cumulative token budget)

Semantics: after each response compute
`contextTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`
(the full prompt the model just saw plus what it wrote — Claude Code's canonical measure). Run ends `budget_exceeded` when one response's `contextTokens` **strictly exceeds** the cap (spendable in full, boundary semantics unchanged). Guard order unchanged: completion check first, then `max_turns`, then this. Known simplification: no estimation of just-appended tool results — drift is bounded by Part 4's batch cap; documented in the field's doc comment.

Changes:
- `src/loop/agentLoop.ts`: `LoopConfig.maxTokens` → **`maxContextTokens`** (validation `>= 0` unchanged); `BudgetReason` `'token_budget'` → **`'context_budget'`**; guard body per above. Cumulative `totals` keep accumulating (now 4 sums incl. cache_creation) — observability only, no longer a guard.
- `RunMetrics` (additive, existing field names unchanged): add `cacheCreationInputTokens` (sum) and `peakContextTokens` (max per-request `contextTokens` over the run — the depth number for cross-baseline comparison).
- `src/cli/runTask.ts`: `DEFAULT_MAX_TOKENS = 250_000` → `DEFAULT_MAX_CONTEXT_TOKENS = 200_000`; `RunTaskConfig.maxTokens` → `maxContextTokens`.
- Rename ripple: `src/tui/bridge/runSession.ts`, `src/tui/bridge/runtime.ts` (passthrough), `src/cli/replFormat.ts` (guard-name text), affected tests. `evals/` reads none of these fields — no eval-side changes.

**Default: 200,000 tokens/request (proposed).** Note: observed per-request context at death was ~20–35k, so 200k rarely binds and `maxTurns` becomes the effective guard. Alternative if the context guard should be the binding constraint: **100,000**. Decide with Step 0 data in hand.

## Part 3 — Cache-miss tripwire

`src/loop/agentLoop.ts`: after accumulating usage, if `turn >= 2` and `cache_read_input_tokens` is 0/absent, append transcript event `{type: 'cache_miss_warning', turn}` (additive event type). Two-line version of Claude Code's `promptCacheBreakDetection` — makes a silently broken prefix visible in the run dir.

## Part 4 — Tool-result batch cap (per message)

- New constant `MAX_TOOL_RESULTS_PER_MESSAGE_BYTES = 200_000` (4× the per-result cap, Claude Code's ratio; **bytes, deliberately** — see `capResult.ts:8-13`: bytes are the more conservative token proxy (Claude Code itself estimates at `BYTES_PER_TOKEN = 4`) and match the offload file mechanics; note the unit choice in the doc comment so nobody "fixes" it to chars).
- Enforced in the loop after `scheduleToolCalls`, before pushing the user message: while the batch's total content bytes exceed the cap, offload the **largest** not-yet-offloaded result via `capResult` (previews, manifest hashes, provenance all preserved). Messages evaluated independently (150k this turn + 150k next turn are both untouched).
- Why: 5 parallel reads × 50k = 250k bytes (~60k tokens) can land in one user message today, each result individually legal. Remedy is offload (run keeps going), not death. Also bounds the context guard's blind spot (next request exceeds last measured context by ≤ ~50k tokens), so no token estimation is needed anywhere.

Existing limits unchanged: per-result 50,000 bytes, preview 2,000 bytes, parallel reads 5, `maxOutputTokens` 8,192.

## Tests

- `callModel.test.ts` (extend existing describe): marker on last block of last message (1-message and multi-turn histories with tool_results); exactly 2 `cache_control` markers per request; none on earlier messages; prefix still byte-identical across calls; input messages not mutated (clone requirement).
- `streamAssembly.test.ts`: `cache_creation_input_tokens` captured from start and delta events.
- `agentLoop.test.ts`: guard trips when one response's `contextTokens` strictly exceeds cap; continues at exactly cap; a scripted run whose cumulative sum far exceeds the cap but per-request sizes stay under runs to completion; completion-before-guard boundary preserved; metrics carry the two new fields; `cache_miss_warning` appears iff turn ≥ 2 with zero cache reads.
- Batch cap tests: batch under cap untouched; over cap → largest offloaded first until under; offloaded results readable via `read_file`/`grep`; manifest records hashes.

## Verification after implementation

- Live run: `cache_read_input_tokens` nonzero from turn 2; `cache_creation_input_tokens` nonzero every turn; no `cache_miss_warning` events.
- Latency on late turns visibly lower than baseline.

## Reporting note

`metrics.json` from Step 1 onward is **not comparable** to the 2026-08-11 baselines: `budget_exceeded` changes meaning. Next report must state the new semantics and compare via `peakContextTokens` + real cost derived from the four token sums (weights ≈ 1× input, 1.25× cache_creation, 0.1× cache_read, 5× output).

## Decisions log

1. Context formula includes `output_tokens` (Claude Code canonical) — **agreed**.
2. Default `maxContextTokens` — **200k, confirmed by Step 0 data**: projected per-request context at completion depth (~50–70 turns) is ~150–220k, so 100k would bind around turn 33, before completion. Caveat: 60–70-turn runs will brush 200k; if Step 2 shows `context_budget` deaths, the remedy is cheaper repeat-page representation, not a bigger cap.
3. Renames `maxTokens` → `maxContextTokens`, `'token_budget'` → `'context_budget'` — **agreed**.
4. Tripwire as transcript event — **agreed**.
5. Batch cap in bytes (not chars), 200k, offload-largest-first — **agreed** (chars considered and rejected: JS `.length` is unprincipled, bytes are the stricter token proxy, and the offload mechanics are byte-based).
6. No token-counting API calls and no char/4 estimation in the guard — usage from each response is exact and free; Part 4 bounds the only blind spot.
