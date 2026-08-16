# Architecture

Current v3-only architecture as of 2026-08-15. For rationale and migration history, see [the v3 design](../../docs/browser-agent-v3/sherlock-v3-design-doc.md) and [implementation plan](../../docs/browser-agent-v3/implementation-plan.md).

## System overview

```mermaid
flowchart TD
    TUI["Sherlock TUI\nattached local Chrome or Browserbase"] --> RT["runTask / resumeTask\nsrc/cli/runTask.ts"]
    REPL["Minimal REPL\nmanaged session"] --> RT
    EVAL["Eval runner\nmanaged browser lanes"] --> RT
    RT --> C["v3 coordinator\nsrc/v3/run/coordinator.ts"]
    C --> I["Immutable contract initializer"]
    C --> W["Sequential worker session"]
    C --> D["Deterministic finish checks"]
    C --> V["Fresh read-only verifier"]
    W --> P["Tool pipeline"]
    P --> TOOLS["8 tools\nbrowser_execute, publish_artifact,\nread/write/edit_file, bash, ask_user, finish"]
    TOOLS --> B["BrowserController"]
    TOOLS --> R["Run directory\nmanifest + artifacts + scratch"]
    C --> CP["v3 checkpoint\nharness/checkpoint.json"]
    R --> G["Eval graders\nrun directory + oracle only"]
```

`src/cli/runTask.ts` is the public composition root. It fixes durable configuration, creates or observes the run directory, builds three model roles and the eight-tool registry, then delegates lifecycle and recovery to `runV3Coordinator`.

## One lifecycle

1. The initializer receives only the task and must return exactly one schema-valid output contract. It gets one initial attempt plus one repair. Once accepted, the contract is immutable and checkpointed; `harness/output-contract.json` is a recoverable convenience projection.
2. The worker receives the task, immutable contract guidance, and durable capability policy. Model responses are fully streamed and validated before content enters history or any tool runs.
3. Ordinary tool calls execute strictly in response order. Each effect boundary is checkpointed conservatively so recovery never blindly replays an uncertain call.
4. A response without tool calls receives a continuation message. It does not complete the run.
5. Completion is requested only by an exclusive `finish` call containing a summary, the claimed requested-output paths, and explicit limitations.
6. Read-only deterministic checks validate manifest integrity, exact output shape, counts/rules, placeholders, roles, and evidence requirements. Defects are returned as the intercepted `finish` call's result and the same worker conversation continues.
7. Passing facts go to a fresh-context verifier with bounded, no-follow access only to `manifest.json` and published `artifacts/`. A correction likewise returns to the worker. Only the verifier can produce `verified`.
8. Every terminal path persists an absorbing checkpoint, closes run-owned pages, writes transcript/metrics projections, and finalizes the manifest. Non-success is explicit `incomplete`, `failed`, or `cancelled` durable state; the public API normalizes successful and incomplete outcomes.

## Layering

```mermaid
graph BT
    RUN["src/run\ndurable files, budgets, provenance"]
    MSG["src/loop/messages.ts\nSDK-free message types"]
    BIF["src/browser/controller.ts + sessionProvider.ts"]
    TF["src/tools\nregistry, access declarations, pipeline, result caps"] --> RUN
    MODEL["src/model\nstreaming + strict ModelDriver"] --> MSG
    V3T["src/v3/tools\n8-tool surface"] --> TF & RUN & BIF
    V3L["src/v3/loop\nworker + context view"] --> MODEL & V3T & RUN
    V3H["src/v3/harness\ninitializer + verifier"] --> MODEL & TF
    V3C["src/v3/completion\nread-only inspections"] --> RUN
    V3R["src/v3/run\ncheckpoint + coordinator"] --> V3L & V3H & V3C & RUN & BIF
    CLI["src/cli/runTask.ts"] --> V3R & V3T & MODEL
    UI["src/tui / src/cli/repl / evals"] --> CLI & BIF
```

`src/loop/` now supplies SDK-free message types only. `getAccess(input)` remains mandatory on every `ToolDef`; the pipeline uses it for resource ownership and timed-out-effect exclusion, while the v3 worker executes calls sequentially.

## Binding invariants

- **One immutable contract.** The initializer authors it before browsing. The worker cannot revise it, and resume rejects configuration or contract drift.
- **Explicit completion.** `finish` is intercepted control flow and must be the only call in its response.
- **Fail closed.** Partial/truncated/refused/unknown model responses never enter history or execute. Deterministic-check or verifier failure cannot become success.
- **Durability before replay.** Checkpoints are schema-validated, monotonically revised, atomically replaced under an exclusive run lock, and terminal state is absorbing. Recovery marks an effect uncertain before dispatch and never replays that boundary blindly.
- **Manifest is the product boundary.** Published files live under `artifacts/` with `requested_output` and/or `evidence` roles; private work lives under `scratch/`. Graders select requested outputs by manifest role, not filenames or transcript claims.
- **Confinement and provenance.** Model paths go through `resolveRunPath`; normal writes go through `writeArtifact` and its durable journal. The deliberate exception is `scratch/workspace/`, where bounded `bash` writes directly and `syncScratchWorkspace` reconciles surviving regular files into the manifest before the tool returns.
- **No task-specific logic.** Runtime behavior and grading helpers remain general; task names/text choose no hidden code paths.
- **Byte-stable worker prefix.** `V3_SYSTEM_PROMPT` and `V3_API_TOOL_DEFS` are static and deterministic. Task, contract, provider, paths, and resume facts belong in messages/checkpoints.
- **Grader isolation.** A grader receives only the run directory path and freshly fetched oracle data, never conversation state.

## Code-execution posture

The worker has two bounded execution capabilities:

- `browser_execute` runs one finite JavaScript program against one exact run-owned page through a protected helper. A durable `javascriptPolicy` explicitly allows or denies it.
- `bash` runs bounded foreground commands in `scratch/workspace/`. Background work, package installation, and secret environment variables are denied.

Neither is an OS security boundary: both run as the application user. Safety comes from capability scoping, finite time/output limits, explicit permissions, secret denylisting, page ownership, and manifest reconciliation.

## Browser policy

Provider choice is explicit in `src/browser/provider.ts`: only `SHERLOCK_BROWSER_PROVIDER=browserbase` starts a remote billable session; local is the fallback.

- **Interactive Sherlock TUI, local:** attaches over a loopback DevTools endpoint to the user's already-running Chrome. Sherlock owns only its client and pages; it never closes pre-existing tabs or the user-owned browser. First-use remote-debugging permission is a visible human step.
- **Minimal REPL, local:** uses a managed persistent profile rather than attached mode.
- **Local evals:** never touch the TUI's attached daily browser. Normal trials lease fresh headless Chrome with unique temporary profiles; headed trials serialize through a separately managed persistent profile.
- **Browserbase:** normal eval trials are context-free isolated sessions. Authenticated/headed work serializes against the configured Context; Live View is the human takeover surface. CDP URLs and API keys must never enter diagnostics, transcripts, artifacts, exceptions, or child environments.

The controller owns run pages explicitly through `prepareTaskPage`/`closeTaskPages`. On resume it first reclaims pages and target sentinels carrying the same durable run marker, while preserving unrelated user tabs, then opens a fresh run-owned page. Ephemeral page references are not checkpoint state.

## Production defaults

| Knob | Default | Source |
| --- | ---: | --- |
| Worker model | `claude-sonnet-5` | `src/model/callModel.ts` |
| Worker output tokens/request | 8,192 | `V3_PRODUCTION_DEFAULTS` |
| Worker turns, whole run | 24 | `V3_PRODUCTION_DEFAULTS` |
| Request context ceiling | 900,000 tokens | `V3_PRODUCTION_DEFAULTS` |
| Tool calls, whole run | 100 | `V3_PRODUCTION_DEFAULTS` |
| Model tokens, all roles | 250,000 | `V3_PRODUCTION_DEFAULTS` |
| Model-visible tool-result bytes | 5,000,000 | `V3_PRODUCTION_DEFAULTS` |
| Whole-run wall time | 3,600,000 ms | `V3_PRODUCTION_DEFAULTS` |
| Deterministic-check failures | 5 | `V3_PRODUCTION_DEFAULTS` |
| Worker/verifier cycles | 3 (2 verifier corrections) | `HarnessConfig` |
| Initializer attempts | 2 | `V3_INITIALIZER_MAX_ATTEMPTS` |
| Per-result offload threshold | 50,000 bytes | `src/tools/capResult.ts` |
| Eval `k` / normal concurrency | 1 / 3 | `evals/config.ts` |

Finite defaults are durable configuration. Resume accepts omitted assertions, but any supplied value must equal the checkpoint; browser provider and `authenticated` authority are always re-stated explicitly.
