# Workflows

Current end-to-end behavior of the production runtime.

## 1. Fresh task run

```mermaid
sequenceDiagram
    participant U as TUI / eval
    participant R as runTask
    participant C as runAgent lifecycle
    participant I as initializer
    participant W as worker
    participant D as deterministic checks
    participant V as fresh verifier
    U->>R: task + live browser + explicit policy
    R->>R: durable configuration, run dir, manifest
    R->>C: runAgent(...)
    C->>C: acquire run lock; write initializing checkpoint
    C->>I: task, contract-only tools
    I-->>C: one immutable OutputContract
    C->>W: task + contract guidance
    loop until a trusted terminal result
        W-->>C: ordered work, or exclusive finish
        C->>D: inspect claim + manifest + bytes
        alt defects
            D-->>W: finish tool result with repairs
        else checks pass
            C->>V: fresh context + facts + published run
            alt correction
                V-->>W: finish tool result with repairs
            else verified
                V-->>C: verified
            end
        end
    end
    C->>C: terminal checkpoint, projections, cleanup
    C-->>R: durable outcome
    R-->>U: runDir + verified/incomplete result
```

`runTask` creates the run directory and manifest before any tool can write. The coordinator owns the run lock, browser task pages, all three role budgets, checkpoint boundaries, and terminalization. The caller owns the browser session; only run-owned pages are closed.

The initializer gets one initial attempt and one repair. It cannot browse or write. The accepted contract becomes immutable before the worker starts.

## 2. Worker turn and completion cycle

```mermaid
flowchart TD
    A["checkpoint ready_for_model"] --> B["build pure context view"]
    B --> C["strict streaming ModelDriver call"]
    C --> D{"complete response accepted?"}
    D -->|no| E["charge known usage; bounded correction or incomplete"]
    D -->|yes| F["persist assistant response"]
    F --> G{"tool calls?"}
    G -->|none| H["append continuation; keep working"]
    G -->|ordinary calls| I["execute sequentially in response order"]
    G -->|capture_screenshot only| P["capture viewport; show pixels once"]
    I --> J["append ordered results; checkpoint"]
    G -->|finish only| K["deterministic read-only checks"]
    G -->|finish mixed with another call| L["execute nothing; protocol correction"]
    K -->|defects| M["append finish result; same conversation"]
    K -->|pass| N["fresh read-only verifier"]
    N -->|needs correction| M
    N -->|verified| O["terminal verified checkpoint"]
    H --> A
    J --> A
    P --> A
    M --> A
```

No-tool prose is not completion. `finish` must be the only call in its response and carries `{ summary }`; deterministic checks derive requested outputs and evidence from the manifest. A summary claim cannot waive a missing output or evidence requirement. Deterministic failures never reach the verifier; verifier corrections resume the same worker conversation. Only verifier acceptance yields public success.

Accounting covers worker turns, request context, tool calls, all-role model tokens, model-visible result bytes, wall time, and deterministic failures. Production leaves aggregate turns, calls, and model tokens unbounded; request context, wall time, per-result/per-message output, and deterministic failures remain bounded. Accounting is monotone and checkpointed.

## 3. Tool execution

The generic pipeline in `src/tools/pipeline.ts` performs:

```mermaid
flowchart LR
    A["registry lookup"] --> B["Zod validation"]
    B --> C["permission gate"]
    C --> D["busy-resource gate"]
    D --> E["bounded execute"]
    E --> F["normalize"]
    F --> G["cap / durable offload"]
    G --> H["ToolCallResult"]
```

Failures become structured model-readable results. A timeout abandons waiting, not necessarily the underlying effect: the effect stays globally busy until its promise settles. Every later call waits through a finite gate, and terminalization drains the registry to a fixed point before releasing ownership.

The worker's nine tools are static and ordered: `browser_execute`, `capture_screenshot`, `publish_artifact`, `read_file`, `write_file`, `edit_file`, `bash`, `ask_user`, `finish`.

- `browser_execute` runs one finite program against one exact run-owned page. Its run-scoped JavaScript policy is durable and explicit.
- `capture_screenshot` observes the exact live viewport as inline pixels. It must be called alone, is visible for one model request, and never writes or publishes an artifact.
- `publish_artifact` is the sole worker publication surface for text, workspace bytes, screenshots, and downloads.
- File editing and `bash` operate in private `scratch/workspace/`; `bash` is foreground-only, bounded, and reconciles surviving files before returning.
- `ask_user` passes through the interactive permission seam. Headless or unavailable environments fail closed instead of hanging.
- `finish` is intercepted control flow and never reaches a generic executor.

## 4. Durable writes and recovery

Normal artifact writes use `writeArtifact`: validate the confined path and partition, persist a write-ahead journal entry, atomically replace bytes, update the manifest hash, and clear the journal. Crash recovery completes or rejects an interrupted transaction before trusted inspection.

The checkpoint store reads regular files without following symlinks, enforces a 64 MiB ceiling and strict schema, writes monotonically through same-directory atomic replacement, and retains exclusive ownership through terminal cleanup. `harness/` permissions are private and its paths are never accepted from the model.

`bash` is the deliberate write-chokepoint exception. It writes directly inside `scratch/workspace/`; `syncScratchWorkspace` then scans without following symlinks, hashes every surviving regular file, removes deleted tracked entries, and fails on unsafe or oversized nodes.

## 5. Crash recovery

```mermaid
sequenceDiagram
    participant P as restarted lifecycle process
    participant C as runAgent
    participant S as locked checkpoint store
    P->>C: existing runDir + durable configuration
    C->>S: acquire lock; bounded no-follow checkpoint read
    S-->>C: authoritative phase state
    C->>C: recover conservatively and continue/repair projections
```

There is no public resume composition API. Crash tests reinvoke `runAgent` on the same run directory; it acquires the run lock, validates configuration and checkpoint state, reconciles journals/workspace effects, and continues the recorded phase. An `uncertain` tool effect is not replayed blindly; verifier work is safe to restart because its view is bounded and read-only. A terminal checkpoint invokes no model work; the lifecycle validates integrity and repairs local projections when needed.

## 6. Browser ownership modes

- **Installed TUI, local:** attach to the user's existing Chrome over an approved loopback DevTools endpoint. Sherlock closes only its own run pages and client connection.
- **Normal local eval:** managed headless Chrome with a unique temporary profile per trial; bounded parallel pool.
- **Headed local eval:** managed persistent profile in a separate serial lane. It never borrows the TUI's attached browser.
- **Browserbase:** isolated context-free sessions for normal work; configured Context for authenticated/headed work. Live View supports human takeover.

Provider selection is explicit. Remote downloads return through Browserbase's API and are hash-verified; uploads travel as bytes. Session-control URLs and API keys never enter transcripts, artifacts, model results, logs, or child environments.

## 7. Evaluation

```mermaid
sequenceDiagram
    participant CLI as eval CLI
    participant RUN as eval runner
    participant A as runTask bridge
    participant O as fresh oracle
    participant G as grader
    CLI->>CLI: load task packages; login preflight
    CLI->>RUN: tasks, k, concurrency, cancellation
    par normal managed lane
        RUN->>A: isolated trial(s)
    and headed managed lane
        RUN->>A: serial trial
    end
    RUN->>O: fetch after run
    O-->>RUN: ground truth
    RUN->>G: runDir + oracle only
    G-->>RUN: assertions
    RUN-->>CLI: ordered EvalReport
    CLI->>CLI: print and persist JSON
```

Browser/model work may overlap, but oracle fetch and grading are serialized independently. `headed` selects the serial lane; `requiresLogin` drives the pre-batch probe. A trial error is recorded and the rest of the batch continues; caller cancellation stops the batch. Never fix evals with task-name or task-text branches.

## 8. Interactive progress, steering, and cancellation

`src/tui/bridge/runSession.ts` forwards attempt-scoped streaming progress in
order, derives publication events from manifest diffs, and translates
`ask_user` into a local dialog. The composer stays live during a run: Enter
journals an update and interrupts active model work, while Esc pauses before
the next model boundary and a second Esc invokes hard cancellation. Running
effects settle, later batch calls are skipped, and steering during checking or
verification rejects the pending finish back to the same worker. Hard
cancellation still reaches models and tools, durably terminalizes the run, and
allows no effect to outlive lock release.

## 9. Developer loops

| Purpose | Command |
| --- | --- |
| Hermetic test suite (local Chrome required for browser suites) | `npm test` |
| Typecheck all TypeScript | `npm run typecheck` |
| Installed TUI | `npm run sherlock` |
| Eval batch | `npm run evals -- --tasks <names> [--k <n>] [--concurrency <n>]` |
| Login/preflight | `npm run login` / `npm run login -- --check` |
| Live Browserbase smoke (billable/networked) | `npm run smoke:browserbase` |

Do not run a new baseline without explicit user direction. Dated measurements remain in `docs/reports/`; current design rationale lives under `docs/browser-agent-v3/`.
