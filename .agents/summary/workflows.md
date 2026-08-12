# Workflows

The key processes end-to-end.

## 1. A task run (`runTask`)

```mermaid
sequenceDiagram
    participant Caller as REPL / eval CLI
    participant RT as runTask
    participant TR as RunTracing
    participant B as BrowserController
    participant L as runAgentLoop
    Caller->>RT: runTask(taskText, { browser, ... })
    RT->>RT: createRunDir + initManifest
    RT->>TR: createRunTracing(); wrapCallModel + wrapRegistry
    RT->>TR: traceRun(taskText, ...)
    TR->>B: newTab()
    opt startUrl provided
        B->>B: goto(startUrl)
    end
    TR->>L: runAgentLoop(taskText, deps, config)
    L-->>TR: LoopResult (metrics.json written)
    Note over RT: finally, nested:<br/>closeTab → finalizeManifest → tracing.close
    RT-->>Caller: { runDir } & LoopResult
```

The browser **session** is never closed by `runTask` — only the tab. Its caller owns the session: interactive/authenticated callers reuse persistent Chrome, while normal eval callers close their isolated headless session and remove its temporary profile after the trial.

## 2. One turn of the agent loop (`src/loop/agentLoop.ts`)

```mermaid
flowchart TD
    A["turnCount += 1"] --> B["append model_request to transcript"]
    B --> C["callModel(state.messages) — streaming"]
    C --> D["append model_response; accumulate usage;\npush assistant message"]
    D --> E{"tool_use blocks\nin content?"}
    E -->|"no"| F["finish: completed\n(finalText = joined text blocks;\nmetrics.json written)"]
    E -->|"yes"| G["append all tool_call events\nin request order"]
    G --> H["scheduleToolCalls:\nread-only batches parallel (≤5),\nstate-changing serialized as barriers"]
    H --> I["append all tool_result events;\npush one user message of tool_result blocks"]
    I --> J{"turn ≥ maxTurns?"}
    J -->|"yes"| K["finish: budget_exceeded / max_turns"]
    J -->|"no"| L{"input+output+cache_read\n> maxTokens?"}
    L -->|"yes"| M["finish: budget_exceeded / token_budget"]
    L -->|"no"| A
```

Notes: completion is checked **before** the budget guards, so a final no-tool response completes even if the budget is exhausted; the token guard is strictly-greater-than, so the budget is spendable in full; `stop_reason` is never consulted.

## 3. Tool execution pipeline (`src/tools/pipeline.ts`)

Every call, six stages, never throws:

```mermaid
flowchart LR
    A["1. exists?\n(unknown → error listing\navailable tools)"] --> B["2. zod validate\n(issues rendered per path)"]
    B --> C["3. execute(input, ctx)"]
    C --> D["4. normalize\n(string pass-through,\nundefined → '', else JSON)"]
    D --> E["5. cap\n(> 50 KB → offload to\ntool-output/, preview + path)"]
    E --> F["6. ToolCallResult"]
    C -.->|"throw"| X["execution_error\n(structured, model-readable)"]
```

Offloaded output is written through `writeArtifact`, so it is hashed into the manifest like any deliverable.

## 4. Browser observation and action

The working cycle the system prompt teaches the model:

1. `navigate` (or start from `startUrl`) → returns the **landed** URL + title.
2. `inspect_page` → `URL / Title` header + the ARIA outline with refs (built from the whole DOM, so no scrolling needed just to read a loaded page).
3. `click <ref>` / `type <ref>` — the tool re-reads the outline first to attach a human description to the transcript and catch stale refs before acting; stale refs return "run inspect_page again and use a current ref."
4. For lazy-loading pages (infinite scroll): `scroll` → `inspect_page` again (fresh refs, newly loaded content), or `scroll` → `screenshot` to frame a viewport capture.
5. `screenshot { filename, fullPage? }` and `download { ref, filename? }` write evidence with `sourceUrl` provenance; `download` fetches through the browser session (cookies apply) and rejects non-2xx. JS-triggered downloads (no href) are a known gap — the error message says so.

## 5. Run persistence

Ordering guarantees: `initManifest` happens before the loop starts (so `writeArtifact` can never write untracked files); `metrics.json` is written by the loop's single `finish()` funnel on every exit path; `finalizeManifest` stamps `finishedAt` in `runTask`'s `finally` even when the loop throws. The transcript is synchronous append-only JSONL — serialize-before-write so a bad event can't corrupt the file.

## 6. Running evals

```mermaid
sequenceDiagram
    participant CLI as evals/runners/cli.ts
    participant R as runEvals
    participant A as runTask (real agent)
    participant O as Oracle (live API)
    participant G as Grader
    CLI->>CLI: parse --tasks/--k/--concurrency; load tasks
    CLI->>R: runEvals(tasks, k, { concurrency, runTask })
    par normal jobs (bounded pool, default 3)
        R->>A: isolated headless Chrome + temp profile + runTask
    and authenticated jobs (serial lane)
        R->>A: shared headed chrome-profile + runTask
    end
    loop completed trials (one-slot grading queue)
        A-->>R: { runDir } (+ latency timed)
        R->>O: fetchOracle() — at grading time
        O-->>R: oracleData
        R->>G: grade(runDir, oracleData)
        G-->>R: AssertionResult[] (≥1 or the harness throws)
    end
    R-->>CLI: EvalReport
    CLI->>CLI: print formatReport; writeResults → evals/experiments/<id>.json
    CLI->>CLI: close sessions; remove temporary profiles
```

Modes by parameters: `--tasks hacker_news --k 1` (debugging inner loop), `--k 3 --concurrency 3` (parallel consistency run), or lower concurrency for resource-constrained machines. `requiresAuth` metadata, never task-specific runtime logic, selects the headed serial lane. The development done-bar remains every task passing all 3 trials.

**Fixing a failing eval:** the binding rule is general mechanisms only — improve the outline, tool results, or prompt; never task-specific branches. Log failures and candidate mechanisms in `.agents/planning/.../implementation/baseline-failure-log.md` (see `docs/reports/2026-08-11-baseline.md` for the worked example).

## 7. Tracing

Per run (when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set): a root `run-evidence-agent` agent span (input = task text; metadata = turnCount, toolsUsed, latencyMs) with children `call-model` generation spans (token `usageDetails`, including `cache_read_input_tokens` — the explicit prompt-caching verification signal) and `execute-<tool>` tool spans (`resultBytes`). Without credentials everything is an identity no-op; tracing failures can never change a run's outcome. The JSONL transcript + `metrics.json` remain the durable local record regardless.

## 8. Developer loops

| Loop | Command |
| --- | --- |
| Unit/integration tests (no network beyond loopback; needs local Chrome) | `npm test` |
| Typecheck (covers `src`, `demos`, `evals`, `tests`) | `npm run typecheck` |
| Interactive agent session | `npx tsx --env-file=.env src/cli/repl.ts` (or `npm run agent` with ambient env) |
| One eval task, once | `npx tsx --env-file=.env evals/runners/cli.ts --tasks hacker_news --k 1` |
| Subsystem walkthrough | `npx tsx demos/<nn>-<name>.ts` (09/14 need the API key; 10–14 need Chrome) |
| Inspect a run | read `runs/<id>/transcript.jsonl`, `manifest.json`, `metrics.json`; or the Langfuse trace |
