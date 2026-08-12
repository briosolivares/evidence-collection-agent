# Spec: Retry on transients (oracle fetch + model call) & metrics on crash

**Date:** 2026-08-11 · **Status:** implemented 2026-08-11 (all three parts; full suite + typecheck green); live-verified 2026-08-11 evening — see Verification below
**Motivated by:** `docs/reports/2026-08-11-medium-rebaseline.md` — three consecutive eval attempts crashed on transient failures, none in harness code: `fetch failed` from the grading oracle's bare `fetch()` (attempts 1 and 3), and an Anthropic `overloaded_error` surfaced mid-stream, which the SDK never retries (attempt 2). One crashed model call also leaves no `metrics.json` (run `…_3181ed`): `runAgentLoop` throws before `finish()`.
**Mechanism provenance:** Claude Code disables SDK auto-retry (`maxRetries: 0` — `claude-code/src/services/api/claude.ts:1781`, "Disabled auto-retry in favor of manual implementation") and owns retries in `src/services/api/withRetry.ts`: `DEFAULT_MAX_RETRIES = 10`, `MAX_529_RETRIES = 3`, exponential backoff honoring retry-after, ECONNRESET/EPIPE keep-alive healing, 529 retries only for foreground query sources. We borrow the shape at harness scale, not the numbers.
**Why retries are cheap now:** a retried request is byte-identical, so it re-reads the prompt cache the failed attempt already wrote (0.1×). Part 1 of the cache spec made this mechanism nearly free.

Three independent parts. Parts A and B are retry loops. **Part C is not a retry loop** — it is crash bookkeeping only: catch, record, rethrow.

## Part A — Oracle fetch retry

New `evals/oracles/fetchWithRetry.ts`, adopted by `githubGet` (`evals/oracles/githubApi.ts`) — the seam every GitHub-based oracle already shares.

- **Attempts: 4 total** (1 + 3 retries). Backoff **1s / 2s / 4s, ±50% jitter**. Honor a `Retry-After` header when present and **≤ 30s**; a longer one fails fast (grading shouldn't hang).
- **Retry on:** thrown fetch errors (network — `fetch failed`, ECONNRESET, DNS) and responses with status **408, 429, or ≥ 500**.
- **Fail fast on:** all other 4xx. GitHub rate-limit exhaustion (403/429 with exhausted `x-ratelimit-remaining`) keeps its existing raise-the-limit error message — a reset an hour away is not a retryable event.
- Injectable `fetch` and `sleep` for tests (the suite stays hermetic — the live-HTTP seam is never called in tests, per the file's existing contract).
- `hackerNewsClient.ts` and `edgarClient.ts` adopt the same helper as a follow-up when those tasks are next touched — noted, not in scope.

## Part B — Model-call retry

The retry span must cover **stream creation AND consumption**: `client.messages.stream(...)` (the POST) plus the whole `assembleModelResponse` iteration. The SDK's built-in retry covers only the POST; mid-stream SSE `error` events and dropped connections throw out of the iteration unretried — that is what killed attempt 2.

- New `src/model/callWithRetry.ts`: `callWithRetry(attempt: () => Promise<ModelResponse>, opts: { signal?: AbortSignal; onRetry?: (info) => void; sleep?: ... })`. Used by both call sites:
  - `makeCallModel` (`src/model/callModel.ts`) — wraps lines ~121–128 (create + assemble) per attempt.
  - TUI bridge `callModel` (`src/tui/bridge/runSession.ts`) — same wrap around its `createStream` + `assembleModelResponse`.
- **Single retry authority:** construct the client with `new Anthropic({ maxRetries: 0 })` (both sites), matching Claude Code. Otherwise SDK retries nest inside ours (up to 12 requests for one turn).
- **Attempts: 4 total.** Backoff **1s / 2s / 4s, ±50% jitter**; honor `retry-after` when the error carries one, **capped at 60s**.
- **Retryable:** `Anthropic.APIConnectionError`; `Anthropic.APIError` with status 408, 409, 429, or ≥ 500 (529 included); SSE error events whose type is `overloaded_error` / `api_error`; and stream-truncation failures from assembly (connection died mid-stream).
- **Never retried:** aborts (`AbortError` — TUI cancellation must propagate immediately, including out of a backoff sleep); other 4xx (400 invalid request, 401/403 auth, 404); deterministic assembly errors (unsupported block type, unparseable tool-input JSON) — retrying those reproduces them.
  - To classify without regexing messages, `streamAssembly.ts` gives its two truncation throws (`no message_start`, `unterminated content blocks`) a distinguishing error `name: 'TruncatedStreamError'`; its deterministic throws keep plain `Error`.
- **Progress surface:** `ProgressEvent` gains `{ type: 'retry'; turn; attempt; delayMs; reason }` (additive). `replFormat.ts` prints one line (`[turn N] retrying 2/4 in 2.1s — overloaded_error`). Known cosmetic wart, documented not fixed: a failed attempt may already have streamed partial `text_delta`s, so the REPL/TUI can show a duplicated sentence fragment before the retry line.
- **Accounting caveat (documented in RunMetrics doc comment):** failed attempts bill real tokens upstream but report no usage to us; metrics record only the successful attempt's usage, so retried turns undercount true cost slightly.

## Part C — Metrics on crash (NOT a retry loop)

Nothing is re-attempted. `runAgentLoop` (`src/loop/agentLoop.ts`) wraps its `while` loop in try/catch; on a throw it:

1. appends transcript event `{ type: 'run_error', turn, message }` (additive event type),
2. writes metrics via the existing `finish()` path with **`status: 'failed'`**,
3. **rethrows** — every caller (REPL, TUI bridge, eval runner) sees exactly the rejection it sees today; nothing about control flow changes.

Type change: `RunMetrics.status` widens to `'completed' | 'budget_exceeded' | 'failed'`. `LoopResult` is **unchanged** — `'failed'` is a metrics-file status only, never a returned result (the function rethrows instead of returning).

Considered and rejected for now: returning `{ status: 'failed' }` instead of rethrowing, which would let an eval grade a crashed trial as a failed trial and continue instead of aborting. That is a semantics change for every caller; with Part B making unrecoverable crashes rare and `regrade.ts` covering recovery, not worth it yet. Logged as a future option.

## Tests

- `fetchWithRetry`: succeeds after 2 rejections; retries 503 then succeeds; no retry on 404; honors small Retry-After; gives up after 4 attempts with the last error; rate-limit message preserved. All with injected fetch/sleep.
- `callWithRetry`: retries on APIConnectionError / 529 APIError / TruncatedStreamError, succeeds on attempt k; passes non-retryable errors through on attempt 1; respects 4-attempt cap; abort during backoff rejects immediately with AbortError; onRetry called with attempt/delay/reason; injected sleep — no real timers.
- `callModel.test.ts`: client constructed with `maxRetries: 0`; prefix stability tests unaffected.
- `agentLoop.test.ts` (Part C): scripted callModel throws on turn 2 → the loop rejects AND `metrics.json` exists with `status: 'failed'`, `turns: 2`, turn-1 totals; transcript ends with `run_error`; a successful run's metrics unchanged.
- `replFormat.test.ts`: retry event renders.

## Verification after implementation

- Kill the network mid-eval-grading once (or point `githubGet` at a flaky mock): grading survives.
- Full test suite + typecheck.
- Next multi-trial eval lands without a regrade.

**Result (2026-08-11 evening, easy + medium suites, 15 trials):** the "lands without a regrade" criterion is met — both suites ran end-to-end and graded in-process on the first attempt (vs. three consecutive crashed attempts pre-mechanism). The retry loops themselves went **unexercised**: zero retry events across ~470 turns and eight oracle fetch groups (no transients occurred), so Parts A/B/C remain live-untested and covered by the unit suite only. The same run verified the companion `maxTurns`-off change: five of six medium trials ran to 76–94 turns with the 200k context ceiling terminating two of them. Report: `docs/reports/2026-08-11-retry-maxturns-off.md`.

## Decisions log

1. SDK `maxRetries: 0`, single manual retry authority (Claude Code's approach) — **agreed**.
2. 4 attempts / 1-2-4s ±50% jitter for both loops; retry-after caps 30s (oracle) / 60s (model) — **agreed**.
3. Part C rethrows; `'failed'` exists only in metrics.json; return-instead-of-throw deferred — **agreed**.
4. Truncated-stream classification via error `name`, not message regex — **agreed**.
5. Duplicate-delta cosmetic wart on retried turns accepted and documented — **agreed**.
6. Failed-attempt token usage not counted in metrics (documented caveat) — **agreed**.
7. *(added during implementation)* Part C exempts aborts: an error named `AbortError` rethrows with **no** bookkeeping, preserving the pre-existing cancellation artifact contract (cancelled run = finalized manifest, **no** metrics.json — "stopped", not "crashed", for the /runs browser; tests/tui/cancellation-artifacts.test.ts). The TUI bridge normalizes any post-abort failure (SDK abort errors keep the default `Error` name; a killed stream can surface as truncation) to `name: 'AbortError'` so the carve-out fires reliably.
8. *(separate request, same session)* `maxTurns` turned off by default: `LoopConfig.maxTurns` now accepts `Infinity` and `runTask`'s `DEFAULT_MAX_TURNS` changed 60 → `Infinity`, so runs follow their trajectory uncapped. Termination is still guaranteed by `maxContextTokens` (per-request context grows every turn). Pass a finite `maxTurns` to restore a cap.
