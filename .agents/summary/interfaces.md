# Interfaces and Integration Points

Current public and internal seams for the v3-only runtime.

## Runtime boundaries

```mermaid
flowchart LR
    UI["TUI / REPL / eval runner"] --> API["runTask / resumeTask"]
    API --> COORD["runV3Coordinator"]
    COORD --> MD["ModelDriver"]
    COORD --> REG["ToolRegistry"]
    REG --> CTX["ToolCtx"]
    CTX --> B["BrowserController"]
    UI --> SP["BrowserSessionProvider"]
    SP --> B
    API --> TR["RunTracing"]
    COORD --> CP["V3CheckpointStore"]
```

### Browser seam

`BrowserController` in `src/browser/controller.ts` is engine-neutral and deliberately small. It exposes durable task-page preparation/cleanup, stable `{pageId, url, active}` summaries, target-pinned command sessions, native-dialog state, screenshots, downloads, and safe diagnostics. File upload is a protected command-session operation so the provider can encode local bytes without exposing a path or CDP authority to remote Chrome. A controller owns only pages marked for the run; attached local mode must not close the user's existing tabs or browser.

`BrowserSessionProvider` in `src/browser/sessionProvider.ts` has one acquisition method:

```ts
interface BrowserSessionProvider {
  createSession(): Promise<BrowserController>;
}
```

`src/browser/provider.ts` is the only environment-to-provider composition point. Provider choice is explicit (`local` or `browserbase`), and local ownership is also explicit (`attached` or `managed`). `BrowserSessionDiagnostics` deliberately omits the remote CDP URL.

### Model seam

`ModelDriver` in `src/model/modelDriver.ts` is the role-independent strict boundary:

```ts
interface ModelDriver {
  generate(options: {
    messages: readonly Message[];
    signal?: AbortSignal;
    onEvent?: (event: ModelAttemptEvent) => void;
  }): Promise<AcceptedModelResponse>;
}
```

A complete stream must assemble and pass stop-reason/content/tool-call validation before it enters history or executes. The SDK-free `Message`, `ModelResponse`, and `CallModel` compatibility types remain in `src/loop/messages.ts`; only `src/model/` knows Anthropic SDK types.

### Tool seam

`ToolDef`, `ToolRegistry`, and `ToolCtx` live in `src/tools/registry.ts`:

```ts
interface ToolDef<Input> {
  name: string;
  description: string;
  inputSchema: ZodType<Input>;
  getAccess(input: Input): ToolAccess;
  maxBytes?: number;
  requiresUserInteraction?: boolean;
  timeoutMs?: number;
  execute(input: Input, ctx: ToolCtx): Promise<unknown> | unknown;
}
```

`ToolCtx` carries `runDir`, optional browser and permission/cancellation seams, and the run-owned busy-resource ledger. `getAccess` is mandatory and derives concrete read/write/exclusive resources from validated input. The worker dispatches calls sequentially; access declarations still prevent a later call or terminalization from overlapping an abandoned timed-out effect.

`src/v3/tools/index.ts` exports `V3_API_TOOL_DEFS` and `createV3ToolRegistry`. API definitions are static, deeply frozen, and ordered identically to the registry so the cached prompt prefix is byte-stable.

## Public run API (`src/cli/runTask.ts`)

```ts
runTask(taskText: string, config: RunTaskConfig): Promise<RunTaskResult>
resumeTask(runDir: string, config: ResumeTaskConfig): Promise<RunTaskResult>

type RunTaskResult = { runDir: string } & RunOutcome
type RunOutcome =
  | { status: 'verified'; finalText: string }
  | { status: 'incomplete'; reason: IncompleteRunReason; detail: string; finalText: string }
```

Both configurations require a live `BrowserController` and accept model/progress/tracing/permission/cancellation seams. A fresh run may set durable model, start URL, authentication, JavaScript policy, and finite ceilings. Resume reads those values from the checkpoint; any caller-supplied assertion must match, and `authenticated` is required explicitly because a newly acquired browser's authority cannot be inferred from old state.

On normal resolution the coordinator has persisted terminal state, reconciled run projections, closed run-owned pages, and finalized the manifest. The public composition root closes its tracing lifecycle; the caller still owns the browser session.

## Checkpoint observation and ownership (`src/v3/run/checkpoint.ts`)

`readV3CheckpointConfiguration(runDir)` and `readV3CheckpointResumeInfo(runDir)` are lock-free composition hints. They perform bounded, no-follow, schema-validated reads and return detached recursively frozen configuration (plus the phase for the latter). They write nothing and acquire no lock. The coordinator never trusts that pre-lock observation alone: it opens `V3CheckpointStore`, re-reads the complete checkpoint under exclusive ownership, and revalidates configuration and contract.

`openV3CheckpointStore(runDir)` is the mutating seam. Its `load`, monotonic `save`, and `close` operations own the run lock, atomic checkpoint replacement, stale-lock recovery, and terminal-state constraints.

## Tracing and progress

`RunTracing` in `src/tracing/runTracing.ts` can announce a run directory, wrap model calls and the tool registry, create the run root, flush, and close. Without both Langfuse keys it is an identity no-op; tracing failures are isolated from outcomes. An already-terminal resume announces the directory for local UI use but creates no new external trace root.

`ProgressEvent` from `src/model/callModel.ts` and attempt events from `src/model/modelDriver.ts` feed `src/tui/bridge/runSession.ts`. Published-artifact UI events are derived by diffing the manifest after tool execution; they are not a second provenance channel.

## Eval harness contracts

`evals/types.ts` defines:

```ts
type Grader = (
  runDirPath: string,
  oracleData: unknown,
) => AssertionResult[] | Promise<AssertionResult[]>

type RunTaskFn = (
  taskText: string,
  options: EvalRunOptions,
) => Promise<{ runDir: string }>
```

A loaded `EvalTask` carries `name`, `taskText`, optional `startUrl`, `headed`, `requiresLogin`, `fetchOracle`, and `grade`. `task.json` accepts `task`, optional `startUrl`, optional boolean `headed`, and optional service-id array `requiresLogin`. Graders receive only the run directory and freshly fetched oracle data, never the transcript or model conversation.

The CLI surface is `npm run evals -- --tasks <a,b,c> [--k <n>] [--concurrency <n>] [--skip-login-check]`. Normal trials use a bounded managed-browser pool; headed trials use a separate serial managed lane. Results are written under `evals/experiments/`.

## External integration points

| Service/capability | Boundary | Important constraint |
| --- | --- | --- |
| Anthropic Messages API | `src/model/callModel.ts` | Streaming only; cached static prefix; credentials stay ambient. |
| Local Chrome | `src/browser/` | TUI interactive mode attaches; REPL/evals use managed sessions. |
| Browserbase | `src/browser/browserbase*` | Explicit provider selection only; CDP URL is a secret control capability. |
| Langfuse/OTel | `src/tracing/runTracing.ts` | Optional and failure-isolated. |
| Eval oracles | `evals/datasets/*/oracle/` | Fetched at grading time; GitHub needs a token for sustained runs and SEC needs its plain User-Agent. |

## Environment

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` / supported SDK auth | Real model access. |
| `SHERLOCK_BROWSER_PROVIDER` | Explicit `local` or `browserbase`; local is the fallback. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_CONTEXT_ID` | Remote sessions and authenticated Context use. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Optional tracing. |
| `GITHUB_TOKEN` | Prevents eval-oracle rate-limit failures. |

There is no general-purpose dotenv import in application modules. The installed TUI, eval CLI, login command, and agent command load the repository `.env` at their documented entry boundaries; standalone scripts need `--env-file=.env` explicitly.
