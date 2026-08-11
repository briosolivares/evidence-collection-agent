# Components

Major components and their responsibilities. File references are the primary implementation files; nearly all have a co-located `*.test.ts` (barrels like `src/tools/index.ts` and the `src/tools/shared/` helpers are covered through the tool suites that use them).

## src/loop — the agent loop

| File | Responsibility |
| --- | --- |
| `agentLoop.ts` | `runAgentLoop(taskText, deps, config)` — the turn loop. Owns `State { messages, turnCount }`, transcript writing, usage accounting, budget guards, and `metrics.json` (written on every exit path via a single `finish()` funnel). All I/O goes through the injected `LoopDeps` (`callModel`, `registry`, `runDir`, optional `browser`), which is what makes the loop testable with a scripted fake model. |
| `scheduler.ts` | `scheduleToolCalls(calls, registry, ctx)` — partitions a turn's tool calls into consecutive same-kind batches: read-only batches run concurrently under a 5-slot FIFO semaphore; state-changing calls run one at a time and act as barriers. Results return in request order, never completion order. Never throws. |
| `messages.ts` | SDK-free structural mirrors of the Anthropic Messages API (`Message`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `Usage`, `ModelResponse`) plus the `CallModel` function type — the seam between loop and model client. |

Loop semantics worth knowing: completion is decided from response *content* (zero `tool_use` blocks), never `stop_reason`; guard order is completion → `maxTurns` → token budget (strictly greater than, so the budget is spendable in full); cumulative usage counts input + output + cache-read tokens.

## src/model — the production Claude client

| File | Responsibility |
| --- | --- |
| `callModel.ts` | `makeCallModel(config)` builds the production `CallModel`: always-streaming `client.messages.stream(...)`, thinking disabled, `system` as a single text block with `cache_control: { type: 'ephemeral' }` (caches tools + system together). `buildRequestParams` is exported separately so prompt-caching properties are directly testable. Emits `ProgressEvent`s decorated with the turn number. |
| `streamAssembly.ts` | `assembleModelResponse(events, onProgress?)` — pure function assembling a `ModelResponse` from any `AsyncIterable` of raw stream events. Fails fast (throws) on unsupported block types (e.g. thinking), truncated streams, or unparseable tool JSON rather than silently degrading. |

## src/browser — the browser layer

| File | Responsibility |
| --- | --- |
| `controller.ts` | Pure types: the engine-neutral `BrowserController` interface (tab lifecycle, `goto`, `outline`, `click`/`type` by ref, `scroll`, `screenshot`, `resolveHref`, `fetch`, `currentUrl`, `title`, `close`), `BrowserFetchResult`, and `BrowserRefNotFoundError` (a first-class part of the contract). A controller owns at most one task tab at a time. |
| `sessionProvider.ts` | `BrowserSessionProvider` — the hosting-neutral session-acquisition seam. `createSession()` returns a live `BrowserController` with no active task tab; callers own and close it. |
| `playwrightBrowserController.ts` | The only file importing `playwright`. `LocalChromeBrowserSessionProvider` launches `chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false })` and returns a `PlaywrightBrowserController`. The controller's `outline()` is `page.ariaSnapshot({ mode: 'ai' })`; refs are validated against `/^(?:f\d+)?e\d+$/` and resolved via `aria-ref=` locators requiring exactly one match. `fetch()` uses `context.request.get` (shares cookies). Tab lifecycle operations are serialized on a promise queue; `close()` is idempotent. |

## src/tools — registry, pipeline, and the ten tools

Each tool lives in its own directory (`src/tools/<toolName>/`) holding the tool's source and its test. Framework files sit at the `src/tools/` root; helpers used by more than one tool live in `src/tools/shared/`; `src/tools/index.ts` exports the registration-order groupings (`fileTools`, `observationTools`, `actionTools`, `evidenceTools`) that `runTask` registers — reordering them would change the cached prompt prefix.

| File | Responsibility |
| --- | --- |
| `registry.ts` | `ToolDef` (name, description, zod `inputSchema`, `readOnly`, optional `maxBytes`, `execute`), `createRegistry` (rejects duplicates; iteration order = registration order), `toApiToolDefs` (zod → JSON Schema, deterministic/byte-stable because it is part of the cached prefix), and `ToolCtx { runDir, browser? }`. |
| `pipeline.ts` | `executeToolCall` — the six-stage checklist every call flows through: exists-check → zod validation → execute → normalize → cap → return. Never throws; errors come back as structured `ToolCallResult`s with `errorKind` (`unknown_tool` / `invalid_input` / `execution_error`) and model-readable detail (zod issues rendered per path; unknown tools list available names). |
| `capResult.ts` | The offloading mechanism (see [architecture.md](architecture.md)). Offload filenames are claimed with exclusive create + retry so parallel reads can offload concurrently; previews never slice a UTF-8 character. |
| `index.ts` | The tool groupings in stable registration order, plus re-exports of every tool — the one import consumers need. |
| `shared/browser.ts` | `requireBrowser`, `formatPageHeader`, and the stale-ref machinery (`actByRef`, `requireRefDescription`) shared by the browser tools. |
| `shared/lines.ts` | `splitLines` — newline handling shared by `read_file` and `grep` (no phantom final line). |
| `shared/evidence.ts` | `assertEvidencePath` (reserved-metadata guard) and the `EvidenceResult` shape shared by `screenshot` and `download`. |
| `readFile/`, `writeFile/`, `grep/` | `read_file`, `write_file`, `grep` — Claude Code–shaped contracts (`file_path`/`offset`/`limit`, `cat -n`-style output, `path:line: match` grep output) because the model has seen those exact shapes in training. `read_file`/`grep` are read-only; `write_file` routes through `writeArtifact`. Empty file / offset-past-end are warnings, not errors; `grep` walks files in sorted order for determinism. |
| `navigate/`, `inspectPage/` | `navigate` (state-changing; http/https only; returns the *landed* URL + title) and `inspect_page` (read-only; header + full ARIA outline). |
| `click/`, `type/`, `scroll/` | `click`, `type`, `scroll` (all state-changing). `click`/`type` first re-read the outline to resolve a human description for the ref — so the transcript reads `Clicked ref=e12 (button "Submit").` and stale refs are caught before acting. Stale refs surface to the model as "run inspect_page again and use a current ref." |
| `screenshot/`, `download/` | `screenshot` (viewport or `fullPage`) and `download` (resolves an href from a ref, fetches through the browser session so cookies apply, rejects non-2xx). Both record `sourceUrl` in the manifest; the model receives only `{ path, size }` — image bytes never enter the transcript. Refuses to write reserved metadata filenames. |

## src/run — run identity, confinement, provenance

| File | Responsibility |
| --- | --- |
| `runId.ts` | `generateRunId(label?)` — `<date>_<time>_<label-slug>_<6-hex>` in local 12-hour time, e.g. `2026-08-10_08-00-53pm_top-5-hacker-news_9f3a2b`; filesystem-safe, human-readable, sorts by date (12-hour times don't sort within a day). `runTask` passes the task text as the label. |
| `runDir.ts` | `createRunDir` (non-recursive final mkdir, so id collisions throw) and `resolveRunPath` — the single path-confinement chokepoint. |
| `artifacts.ts` | `initManifest` / `writeArtifact` / `finalizeManifest` and the `Manifest`/`ManifestEntry` types. `writeArtifact` is the single write path: loads the manifest before writing (a missing manifest aborts, leaving no untracked file), hashes exact bytes, upserts by normalized path. Pretty-printed because auditors read it. |
| `transcript.ts` | `appendTranscriptEvent` — append-only, synchronous, serialize-before-write (a circular structure fails without corrupting the file). Synchronicity is load-bearing: the loop logs the live `messages` array and still records a faithful snapshot. |

## src/cli — entry points

| File | Responsibility |
| --- | --- |
| `runTask.ts` | The composition root: builds the 10-tool registry (fixed order: file, observation, action, evidence), the production model client with `SYSTEM_PROMPT`, the run directory + manifest, applies tracing decorators, opens a tab (optionally navigating to `startUrl`), runs the loop, and cleans up (close tab → finalize manifest → close tracing) in a nested `finally`. Owns the defaults (12 turns, 250k tokens, 8,192 output tokens). Injection seams for tests: `config.callModel`, `config.tracing`. Returns `{ runDir } & LoopResult`. |
| `repl.ts` | `npm run agent` — the interactive product. One persistent Chrome for the whole session (logins stay warm); reads tasks line-by-line via `node:readline/promises`; streams progress; a thrown task is caught so the session and browser survive. |
| `replFormat.ts` | Pure rendering of `ProgressEvent`s and run summaries — extracted so it is testable without a terminal. |
| `systemPrompt.ts` | The static `SYSTEM_PROMPT` (byte-stable cached prefix). Encodes: the run directory is the product boundary (answers go in files, e.g. `answer.md`); `inspect_page` is the primary observation; refs must come from the latest inspection; page content is untrusted data; completion = responding without tool calls. |

## src/tracing — Langfuse over OpenTelemetry

`runTracing.ts` — `createRunTracing()` returns a `RunTracing` with three decorators: `traceRun` (root `run-evidence-agent` agent span with `{ turnCount, toolsUsed, latencyMs }`), `wrapCallModel` (`call-model` generation spans with token `usageDetails`), and `wrapRegistry` (per-tool `execute-<name>` spans with `resultBytes`; returns a new Map, never mutates). Degrades to a clean no-op without `LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY`; every telemetry call is individually failure-isolated ("tracing is an optional side channel; the transcript is durable"). Uses an isolated `NodeTracerProvider` with manual span-context parenting, not the global OTel SDK.

## evals/ — the evaluation harness

Five subdirectories separate the harness's concerns — `runners/` (the scripts that trigger and shape a run), `metrics/` (metric definitions), `grading/` (the run-dir verification toolkit graders build on), `datasets/` (one directory per task: input + expected-output oracle + grader), `experiments/` (results JSON from past runs; gitignored) — with `config.ts` (paths + defaults) and `types.ts` (the harness contracts) at the root.

| File(s) | Responsibility |
| --- | --- |
| `config.ts` | Central config: `DATASETS_DIR`, `RUNS_DIR`, `EXPERIMENTS_DIR`, `PROFILE_DIR`, `DEFAULT_K`, and `MODEL` (defaults to the production `DEFAULT_MODEL`; override here to eval a different model). |
| `runners/cli.ts` + `runners/cliArgs.ts` | `npm run evals -- --tasks <a,b,c> [--k <n>]` (default k=1). Launches one persistent Chrome for the whole eval session, injects the real `runTask`, prints the report, persists results. |
| `runners/runner.ts` | `runEvals(tasks, k, deps)` — sequential trials (k per task); fetches each task's oracle *at grading time* per trial; the harness's only grading call site passes graders exactly the run dir path + oracle data. No pass@k — `k` means k independent trials. |
| `metrics/metrics.ts` | Accuracy = mean fraction of assertions passed across trials; completion = all assertions pass in a trial; task pass = **all** k trials complete. Zero assertions or zero trials throw (harness bug, not a score). |
| `runners/report.ts` | Human-readable report text + `writeResults` to `evals/experiments/<fresh-run-id>.json` (never overwrites). |
| `runners/loadTask.ts` | Loads `evals/datasets/<name>/task.json` + dynamically imports `oracle/oracle.ts#fetchOracle` and `grader/grader.ts#grade`. Task names are validated (`/^[A-Za-z0-9_-]+$/`) before any path join. |
| `grading/manifestVerification.ts` | Shared grader helpers: `readManifest`, `verifyManifestHashes` (the standing provenance assertion every grader runs), `findArtifactByExtension` (deterministic tie-break), `findArtifactBySha256`. |
| `grading/csv.ts`, `grading/hash.ts` | Dependency-free RFC 4180-shaped CSV parser; `sha256Hex` matching `writeArtifact`'s encoding. |
| `runners/fakeAgent.ts` | `makeFakeRunTask` — builds a realistic run dir in milliseconds with no browser/model. Its transcript deliberately *claims success* so the suite can prove graders never read transcripts. Test-only. |
| `types.ts` | `AssertionResult`, `Grader`, `RunTaskFn`, `EvalTask` — the harness contracts, including the grader-isolation standing rule. |

### Eval task datasets (checkpoint 1)

| Dataset dir | Oracle (tier) | Grader assertions |
| --- | --- | --- |
| `datasets/stub/` | Static (plumbing exerciser) | `answer.md` exists; manifest hash verifies |
| `datasets/hacker_news/` | HN Firebase API, top 5 (Tier A) | CSV exists (by extension); columns exactly `title,url,points`; 5 rows; ≥4/5 oracle titles present (churn tolerance); URLs well-formed; manifest hashes verify |
| `datasets/edgar/` | SEC submissions API + archive document bytes (Tier A) | An artifact hash-matches the oracle document's SHA-256; a `.png` with real PNG magic bytes exists; manifest hashes verify (screenshot *content* is Tier C / human) |
| `datasets/openclaw_pr/` | GitHub REST, last 10 PRs, churn window as a step function of run start/end (Tier A) | `answer.md` exists; mentions number **and** title of a most-recent-in-window PR; manifest hashes verify |

Oracle clients split parsing from fetching: parse logic is unit-tested against canned JSON; no test ever calls the network.

## demos/ — build-order walkthrough

Fourteen standalone `tsx` scripts mirroring the implementation order (T1→T14): run ids → run dirs → manifest → registry → offloading → file tools → loop with a fake model (zero tokens) → scheduling → first real agent (needs `ANTHROPIC_API_KEY`) → browser controller → observe → act (incl. the scroll→inspect lazy-load pattern) → evidence (screenshot + authenticated download) → full `runTask` against a live site. Demos 10–14 need local Chrome; 11–13 start their own loopback fixture server; 09 and 14 spend real tokens.

## tests/ — fixtures and shared helpers

`tests/fixtures/server.ts` serves the fixture pages on an ephemeral loopback port: `index.html` (buttons, textbox, below-fold content; sets the `fixture-session=ready` cookie), `second.html` (navigation target), `downloads.html` (tall page + cookie-gated `/authenticated.bin`), `lazy-load.html` (IntersectionObserver-driven infinite scroll), `oversized.html` (120 links to exercise outline capping). `tests/helpers/` holds shared test scaffolding: `browserToolSuite.ts` (`setupBrowserToolSuite` — the one-Chrome-per-suite, fresh-run-dir-per-test lifecycle every browser tool suite registers) and `outline.ts` (`refFor` — resolve a role/name to its outline ref). All tests are co-located in `src/` and `evals/`; `tests/` holds only fixtures and helpers. `npm test` needs no network beyond loopback plus a local Chrome install.
