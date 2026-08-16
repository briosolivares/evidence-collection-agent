# Components

Responsibilities of the active v3 production modules. Co-located tests pin most boundaries; crash-window tests additionally use child processes under `tests/fixtures/`.

## Public composition and user surfaces

| File/area | Responsibility |
| --- | --- |
| `src/cli/runTask.ts` | The public v3-only composition root. Exposes `runTask` and `resumeTask`, creates durable configuration and model drivers, builds the eight-tool registry, wires tracing/progress, and delegates lifecycle to the coordinator. |
| `src/tui/main.tsx` | Installed `sherlock` TUI edge: env/key setup, attached-local or Browserbase provider selection, interactive runtime, eval runtime, and Ink rendering. |
| `src/tui/bridge/runSession.ts` | Converts `runTask` progress/outcomes, permission questions, tracing, cancellation, and published-manifest changes into UI events. |
| `src/tui/bridge/runtime.ts` | Owns the session-long interactive browser, one run at a time, and browser-death replacement. Local TUI startup receives an already attached controller. |
| `src/tui/bridge/evalRuntime.ts` | Keeps `/evals` on managed browser lanes. Local evals never borrow the attached daily browser. |
| `src/cli/repl.ts` | Minimal line-oriented alternative using a managed persistent session. |
| `src/cli/login.ts` and login helpers | Provider-aware login creation/checking. Browserbase provisions a Context and exposes Live View; local uses the managed profile. |

## `src/v3/run` — durable lifecycle

| File | Responsibility |
| --- | --- |
| `coordinator.ts` | Runs or resumes initializer → worker → checks → verifier. Owns phase transitions, shared budgets/deadline, page ownership, checkpoint hooks, correction cycles, terminal cleanup, and projection repair. |
| `checkpoint.ts` | Strict v3 checkpoint schemas plus the exclusive store. Bounded/no-follow reads; monotonic atomic saves; immutable configuration/contract; stale-lock recovery; lock-free immutable resume observation. |
| `outputContractFile.ts` | Ensures `harness/output-contract.json` matches the checkpointed immutable contract; reconstructs a missing projection and rejects drift. |
| `runDeadline.ts` | One whole-run abort/deadline signal shared across roles and effects. |

Checkpoint phases are `initializing`, `ready_for_model`, `executing_tool`, `checking`, `verifying`, and absorbing `terminal`.

## `src/v3/harness` — initializer and verifier

| File | Responsibility |
| --- | --- |
| `initializer.ts` | Contract-only model role. Forces one `set_output_contract` call, validates the immutable contract, permits one repair, and returns one `OutputContract`. The tool is initializer-private and never executes. |
| `verifier.ts` | Fresh-context semantic review. Owns the report schema/loop, fail-closed repair behavior, role accounting, settled facts, and verified/needs-correction/unavailable result. |
| `verifierTools.ts` | Bounded literal `grep` and windowed `read_file` over published artifacts plus `manifest.json`; rejects scratch, traversal, symlinks, special files, oversized trees/files/images, and performs no offload writes. |

The verifier has no browser and cannot mutate the run. It receives one immutable contract, worker finish claims, user clarifications, and facts already settled by code.

## `src/v3/loop` — sequential worker

| File | Responsibility |
| --- | --- |
| `workerSession.ts` | Full durable worker conversation, strict model turns, no-tool continuation, exclusive `finish` interception, sequential tool dispatch, result bounding/offload, transcript/metrics, checkpoint lifecycle snapshots, and conservative uncertain-effect recovery. |
| `contextView.ts` | Builds a pure model-request view from the never-collapsed durable history. Older large browser results are replaced with deterministic stubs while durable state remains complete. |

Calls in one response execute in order. `finish` mixed with another call executes nothing. A timed-out executor remains registered as busy so later conflicting work and terminalization cannot overlap it.

## `src/v3/completion` — deterministic checks

| File | Responsibility |
| --- | --- |
| `artifactInspection.ts` | Bounded/no-follow manifest and artifact integrity inspection, media inference, path/role validation, and crash-journal recovery support. |
| `tableInspection.ts` | Parses CSV/JSON/Markdown tables and checks exact columns, row counts, uniqueness, expected values, and cell types/formats. |
| `finishChecks.ts` | Compares the exclusive `finish` claim, immutable contract, manifest, published bytes, and evidence. Returns repairable defects or structured positive facts; never writes or revises requirements. |
| `types.ts` | Strict checkpoint-safe facts, defects, and settled-fact schemas. |

## `src/v3/tools` — eight model-visible tools

`src/v3/tools/index.ts` fixes this byte-stable order:

1. `browser_execute` — one bounded async browser program against an exact owned page; run-scoped JavaScript policy and secret denylist.
2. `publish_artifact` — publish text, a workspace file, screenshot, or browser download with explicit manifest roles/provenance.
3. `read_file` — bounded content-aware reads from the run workspace.
4. `write_file` — write private workspace bytes.
5. `edit_file` — exact-match edits to private workspace text.
6. `bash` — bounded foreground local commands in `scratch/workspace/`, followed by manifest reconciliation.
7. `ask_user` — permission-mediated interactive question; unavailable/headless paths fail closed.
8. `finish` — exclusive completion control request, intercepted before generic dispatch.

There is no active legacy tool barrel or one-directory-per-browser-action surface. Browser observation/action is consolidated behind `browser_execute`; publication is consolidated behind `publish_artifact`.

## Shared tool framework (`src/tools`)

| File | Responsibility |
| --- | --- |
| `registry.ts` | `ToolDef`, deterministic registries/API definitions, mandatory `getAccess`, permission types, access keys, and the run-owned busy-resource ledger. |
| `pipeline.ts` | Existence/schema/permission/resource gates, bounded execution timeout, normalization, result capping, and structured errors. It never lets a timed-out effect silently disappear from resource accounting. |
| `capResult.ts` | Per-result and combined-result byte limits. Oversize output is durably offloaded under `scratch/tool-output/` with a bounded UTF-8 preview. |
| `shared/lines.ts` | Stable line splitting used by bounded readers. |
| `bash/runForegroundCommand.ts` | Process-group-aware finite foreground command runner used by the v3 `bash` tool. |

## Model layer (`src/model`, `src/v3/model`)

| File | Responsibility |
| --- | --- |
| `callModel.ts` | Anthropic request construction, static/collapsed-frontier prompt-cache breakpoints, streaming adapter, default model, and compatibility `CallModel` seam. |
| `streamAssembly.ts` | Requires a complete stream and rejects malformed/truncated block assembly. |
| `callWithRetry.ts` | Cancellable bounded retry for transient transport/truncation failures. |
| `modelDriver.ts` | Strict `ModelDriver`: complete response validation, accepted stop reasons, tool-call shape/count checks, one enlarged max-token retry, attempt-scoped progress, and known billable usage on failures. |
| `src/v3/model/budgetedCall.ts` | Charges every role's accepted/rejected model usage into the one durable whole-run budget and persists accounting hooks. |

## Browser layer (`src/browser`, `src/v3/browser`)

| File/area | Responsibility |
| --- | --- |
| `controller.ts` | Minimal engine-neutral `BrowserController`: run-page ownership/preparation/cleanup, safe page summaries, target-pinned command sessions (including protected upload), dialogs, screenshots/downloads, and diagnostics. |
| `sessionProvider.ts` | `BrowserSessionProvider` and provider-safe diagnostics (`local` or `browserbase`). |
| `provider.ts` | The only environment-to-provider composition point; explicit local/Browserbase choice and explicit local `attached`/`managed` authority. |
| `attachedChromeSetup.ts`, `attachedChromeBrowserSessionProvider.ts` | Bounded loopback discovery/approval and non-owning connection to the user's current Chrome. Endpoint values never enter user-visible errors. |
| `playwrightBrowserController.ts` | Shared controller for attached, managed, and remote sessions; owns only tagged run pages, contains late effects, and retires an exact page after an abandoned raw renderer command. |
| `browserbaseBrowserSessionProvider.ts` and download/upload helpers | Remote session lifecycle, Live View/recording diagnostics, Context policy, checksum-verified downloads, and byte-based uploads. |
| `src/v3/browser/runner.ts` + child modules | Executes a bounded browser program in a child process against the exact page/session capability supplied by the controller. |

## Run/provenance layer (`src/run`)

| File | Responsibility |
| --- | --- |
| `runDir.ts`, `runId.ts` | Run creation and the model-path confinement chokepoint. `harness/` is never a model-visible path. |
| `artifacts.ts` | Manifest initialization/read/finalization and `writeArtifact`, the normal provenance write chokepoint. |
| `artifactWriteTransaction.ts`, `atomicFile.ts` | Durable write-ahead journal, fsync, atomic replace, and crash recovery. |
| `syncScratchWorkspace.ts` | No-follow reconciliation of direct `bash` workspace changes into the manifest; rejects symlinks/special/oversized files. |
| `runBudget.ts` | Monotone shared usage, tool, result-byte, wall-time, and verifier-correction accounting with checkpoint snapshots. |
| `transcript.ts` | Append-only JSONL events. |
| `runOutcome.ts` | Public `verified` or explicit `incomplete` result shapes. |

## Tracing

`src/tracing/runTracing.ts` provides optional Langfuse/OTel model/tool/root spans and run-directory announcements. It is an isolated side channel: trace failure never changes run behavior, and terminal resume does not create a new external root trace.

## Evaluation

| Area | Responsibility |
| --- | --- |
| `evals/runners/loadTask.ts` | Validates `task.json` (`task`, optional `startUrl`, `headed`, `requiresLogin`), rejects deprecated metadata keys, and loads oracle/grader functions. |
| `evals/runners/browserRuntime.ts` | Fresh isolated normal browsers plus one serial authenticated/headed managed browser, for local or Browserbase. |
| `evals/runners/runner.ts` | Bounded normal pool, independent serial headed lane, cancellation, deterministic slots, and serialized fresh-oracle grading. |
| `evals/grading/` | Manifest/hash/output helpers used by task graders. |
| `evals/metrics/` and `report.ts` | Trial accuracy/completion, all-of-k task pass, human output, and JSON persistence. |

## Tests and demos

- Source tests are mostly co-located. `tests/tui/` covers public UI bridges and behavior; `tests/fixtures/` contains loopback pages and crash children; `tests/helpers/` owns shared Chrome fixtures.
- The surviving demos are `01`–`05`, `10`, and `12`. They are examples, not a second runtime.
- `npm test` is hermetic except for loopback and requires an installed local Chrome. Live Browserbase behavior is exercised only by the explicit smoke command.
