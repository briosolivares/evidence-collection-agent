# Existing Code Audit — Attaching a TUI with Zero Agent Changes

Researched 2026-08-11 against this worktree. All paths relative to repo root.

## The attach point: `runTask`

The REPL is a thin shell over a real programmatic interface — the agent core never touches the terminal.

- `runTask(taskText, config): Promise<RunTaskResult>` — `src/cli/runTask.ts:79`
- `RunTaskConfig` (`src/cli/runTask.ts:38-62`): `browser` (live `BrowserController`), `runsBaseDir?`, `startUrl?`, `model?`, `maxOutputTokens?`, `maxTurns?`, `maxTokens?`, `onProgress?`, `callModel?`, `tracing?`.
- `RunTaskResult = { runDir } & LoopResult`; `LoopResult` = `{status:'completed', finalText}` | `{status:'budget_exceeded', reason}` (`src/loop/agentLoop.ts:83-85`).
- Defaults (`runTask.ts:32-35`): `runs/` base dir, 8192 output tokens, 12 turns, 250k cumulative tokens.
- Browser ownership is the caller's: acquire it with `BrowserSessionProvider.createSession()` and close the returned `BrowserController` in `finally` — exactly as `repl.ts` does.

## Progress events (the only live channel)

`ProgressEvent` (`src/model/callModel.ts:32-36`), emitted from the model client — not the loop:

```
turn_start {turn} · text_delta {turn, text} · tool_use_start {turn, toolName} · turn_end {turn, usage}
```

- Model calls always stream (Anthropic SDK `client.messages.stream`, `callModel.ts:121`).
- `Usage` = `{input_tokens, output_tokens, cache_read_input_tokens?}` — per-turn only; **the TUI must accumulate its own running total** from `turn_end` (cumulative total lives privately in the loop, `agentLoop.ts:159`).
- Exported, reusable primitives: `buildRequestParams` (`callModel.ts:69`), `assembleModelResponse(events, onProgress)` (`src/model/streamAssembly.ts:51`) — a pure function over the SDK's raw stream events.
- REPL formatting is pure and replaceable: `src/cli/replFormat.ts`.

## Tool registry (10 tools, `runTask.ts:90-95`)

| Tool | Key args for semantic lines | readOnly |
|---|---|---|
| `navigate` | `url` | no |
| `inspect_page` | — | yes |
| `click` | `ref` | no |
| `type` | `ref`, `text` | no |
| `scroll` | — | no |
| `screenshot` | `filename`, `fullPage?` | no |
| `download` | `ref`, `filename?` | no |
| `write_file` | `file_path`, `content` | no |
| `read_file` | `file_path` | yes |
| `grep` | `pattern`, `path?` | yes |

Tool execution: read-only tools parallel (cap 5), state-changing serialized (`src/loop/scheduler.ts`). Errors never throw out of the loop — they become `ToolCallResult{isError:true}` fed back to the model (`src/tools/pipeline.ts:47-110`). Oversize results (>50 KB) offload to `tool-output/*.txt`.

**Gaps for the TUI:**
- `tool_use_start` carries only the tool *name* — no input, no id, no completion/result event.
- Tool inputs/results are visible zero-change via **two routes**: (a) inject `tracing: RunTracing` — `wrapRegistry` (`src/tracing/runTracing.ts:150-192`) sees validated input + raw output per call (caveats: replaces Langfuse tracing unless composed with `createRunTracing()`; misses `unknown_tool`/`invalid_input` rejections; no tool id); (b) tail `<runDir>/transcript.jsonl` (full fidelity: `tool_call` events logged before execution, `tool_result` after, `agentLoop.ts:206-222`).
- Streaming tool-arg JSON deltas are accumulated but never surfaced (`streamAssembly.ts:102-103`) — args are only known when the turn's response is assembled.

## Run lifecycle

1. `generateRunId()` — ISO timestamp + random hex, lexically time-ordered (`src/run/runId.ts:16-23`).
2. `createRunDir` → `initManifest` (`runTask.ts:104-108`).
3. Loop runs; `finally` closes tab → `finalizeManifest` (sets `manifest.finishedAt`) → `tracing.close()` (`runTask.ts:137-149`).

Artifacts: `manifest.json` (`{task, startedAt, finishedAt?, artifacts:[{filename, sha256, sourceUrl?, capturedAt}]}`), `transcript.jsonl` (model_request/model_response/tool_call/tool_result per line), `metrics.json` (`{status, turns, inputTokens, outputTokens, cacheReadInputTokens, wallClockMs}`), evidence files, `tool-output/`.

**Finished-run detection nuance:** `metrics.json` is written only on the loop's normal return paths; a cancelled/crashed run has `manifest.finishedAt` but **no metrics.json** — the run browser must not read that as "crashed".

**Blocker: `runDir` is unknown until `runTask` resolves** (returned only at `runTask.ts:136`; no event carries it). Zero-change workarounds: watch/poll `runs/` for the newest dir (ids sort by time), or capture `ctx.runDir` from an injected tracing wrapper on first tool execution.

## Cancellation — none exists today

Zero occurrences of AbortController/AbortSignal in `src/` or `evals/`. The REPL's SIGINT handler just closes readline; the task runs to completion.

**Zero-change route (chosen, given the zero-agent-changes requirement):** supply a custom `callModel` via `config.callModel`, built from the exported `buildRequestParams` + `client.messages.stream(params, {signal})` + `assembleModelResponse`. Checking/aborting the signal throws out of the loop (no interior catch), through `runTask`'s `finally` (tab closed, manifest finalized), rejecting `runTask`. Granularity: aborts the in-flight model call immediately; a tool batch in progress finishes first (browser ops bounded by Playwright timeouts, typically seconds).

**Critical seam interaction:** passing `config.callModel` **silently bypasses `config.onProgress`** (`runTask.ts:96-102` only wires `onProgress` into the default client) — the custom client must emit all four ProgressEvents itself via `assembleModelResponse`'s `onProgress` parameter plus its own `turn_start`/`turn_end`.

What zero-change cancellation cannot do: abort mid-tool-batch or mid-browser-operation (throwing from a wrapped tool executor is absorbed as an `execution_error` result, not a cancel). Acceptable: Esc means "abort at the model-call boundary; let in-flight tools settle".

## Eval runner as a library

`evals/cli.ts` (not `evals/runners/cli.ts`) is a pure composition root. Exported parts: `runEvals(tasks, k, deps)` (`evals/runner.ts:39`), `loadEvalTask(evalsDir, name)` (`evals/loadTask.ts:20`), `Grader`/`AssertionResult` (`evals/types.ts`), `summarizeTask`/`fractionPassed` (`evals/metrics.ts`), `formatReport`/`writeResults` (`evals/report.ts`).

- **Task registry is a filesystem convention:** `evals/<name>/task.json` + `oracle/oracle.ts` + `grader/grader.ts`. No discovery API — the TUI's task multi-select must `readdir` `evals/` for dirs containing `task.json`. Existing: `stub`, `hacker_news`, `edgar`, `openclaw_pr`.
- **`runEvals` is a fire-and-wait black box** (no per-trial progress; verdicts only in the final report). Zero-change workaround: the TUI drives its own ~15-line trial loop from the exported parts (`loadEvalTask` → `runTask` → `fetchOracle` → `grade` → `summarizeTask` → `writeResults`), emitting UI events between steps.

## Console ownership — clean

The only stdout/stderr writes live in the CLI entry points (`src/cli/repl.ts`, `evals/cli.ts`). Zero sites in `src/loop|model|tools|run|browser|tracing`. Playwright pipes Chrome's stdio (doesn't inherit), so the headed Chrome window doesn't pollute the TTY. An Ink render loop is safe; Ink's `patchConsole` is a belt-and-suspenders fallback.

## Env loading

No dotenv anywhere; `new Anthropic()` (`callModel.ts:113`) reads `ANTHROPIC_API_KEY` from ambient env. Langfuse keys read at `src/tracing/runTracing.ts:60-66`, no-op if missing. → The `sherlock` entry point must load `.env` itself (small TUI-side loader or `--env-file` in the bin shebang wrapper).

## Non-core housekeeping for the TUI

- `tsconfig.json` `include` needs the new TUI dir added.
- `package.json` needs `ink`/`react` deps, a `bin: {sherlock: ...}` entry, and a script.
- `chrome-profile` dir is resolved relative to cwd in `repl.ts:22` — the TUI should resolve its own consistently.
