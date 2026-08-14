# AGENTS.md

Navigation and ground rules for AI agents working in this repository. Deep documentation lives in `.agents/summary/` (start with [index.md](.agents/summary/index.md)); design rationale in `.agents/planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md`; current project state in `.agents/planning/evidence-collection-agent-checkpoint-1/implementation/handoff-state.md`.

## What this is

<!-- metadata: overview, subsystems, navigation -->

A browser agent for audit evidence collection: a minimal Claude Code–style worker session (`src/loop/workerSession.ts`, `createWorkerSession` + `runWorkerCycle`) over eighteen zod-validated tools (one directory per tool under `src/tools/`, assembled in one frozen order — `V2_TOOL_ORDER` in `src/tools/index.ts` — by `createV2Registry`), driving browser sessions through an engine-neutral `BrowserController` and acquiring them through `BrowserSessionProvider` (`src/browser/`). The local Playwright provider can launch either headed persistent Chrome or headless isolated Chrome, as selected by the caller. Every run writes a self-contained directory under `runs/`, named `<date>_<time>_<task-slug>_<suffix>` in local time — `artifacts/` (published outputs and evidence, each manifest entry carrying `roles: requested_output|evidence`, both allowed on one file), `scratch/` (private agent working state, never graded or shown, still hashed — including `scratch/workspace/`, the `bash` working directory), `harness/` (harness-private durable state: `run.lock`, `checkpoint.json`; never a valid model-supplied path), plus `manifest.json` (SHA-256 provenance, exact UTC `startedAt`), `transcript.jsonl`, `metrics.json` — which is the product's output boundary; eval graders read only the run directory and select deliverables exclusively from `requested_output` entries.

| Subsystem | Entry point | Notes |
| --- | --- | --- |
| Composition root | `src/cli/runTask.ts` | The only place loop + model + tools + tracing are wired; both REPL and evals drive it |
| Interactive agent | `src/cli/repl.ts` (`npm run agent`) | One persistent Chrome per session; fresh tab per task |
| Eval harness | `evals/runners/cli.ts` (`npm run evals -- --tasks <a,b,c> [--k <n>] [--concurrency <n>] [--contract-author <initializer\|worker>]`) | Normal trials: parallel isolated headless Chrome (default 3); `headed` trials (`task.json`'s `headed` flag): serial headed `chrome-profile/`; results JSON in `evals/experiments/` |
| Model client | `src/model/` | Streaming always; thinking disabled; prompt caching via one `cache_control` breakpoint |
| Provenance | `src/run/` | `writeArtifact` and `resolveRunPath` are the only write/path chokepoints — with one explicit exception, `scratch/workspace/` (see the workspace-partition rule) |
| Demos | `demos/01…12` | Build-order walkthrough; 09/12 spend real tokens; 10–12 need Chrome |

## Binding project rules

<!-- metadata: rules, constraints, conventions -->

- **No task-specific logic, ever.** Eval failures are fixed with general mechanisms (outline, tool results, prompt) — never `if (task === ...)`. There is a hidden eval set; per-task tuning is worthless.
- **Graders read only the run directory** (path + oracle data). Never point one at a transcript.
- **The prompt prefix must stay byte-stable**: `SYSTEM_PROMPT` is static and `toApiToolDefs` is deterministic; changes that vary the prefix per run break prompt caching (tests assert this).
- **Exact output schema ruling**: a task naming CSV columns means exactly those columns — graders enforce; extra columns fail.
- **`bash` is worker-only, local, and finite.** The absolute prohibition is lifted (it read: "No `bash` tool in the agent, by security design"). The worker may run bounded foreground commands in `scratch/workspace/`; the initializer and the verifier never receive `bash` or `edit_file`, so a contract author and a verdict author still cannot mutate anything. This is **not** a security boundary: commands run as the same OS user as the application, so the original prompt-injection concern (untrusted web content + shell) is mitigated only by exposure scoping, output/time bounds, and manifest provenance — never by isolation. Do not add a remote sandbox, background commands, or package installation without a fresh decision.
- Every tool write goes through `writeArtifact` (hashing into the manifest); every model-supplied path through `resolveRunPath`. Tools must not write `manifest.json`, `transcript.jsonl`, `metrics.json`, `harness.json`, or anything under `harness/`.
- **The one write-chokepoint exception is `scratch/workspace/`.** A `bash` command creates files directly, so bytes land there without passing through `writeArtifact` first. `syncScratchWorkspace()` closes the gap: before the `bash` tool returns, every surviving regular file in that directory is hashed into the manifest and every deleted tracked file is removed from it. Symlinks and special files fail reconciliation loudly rather than being followed. Because the run is not sandboxed, provenance is guaranteed only for surviving files *inside* that directory.
- **A contract-bound deliverable may be written only by the tool that owns it.** `edit_file` refuses any path matching a `filename` declared by the current output contract, directing the worker to `upsert_output_rows` or `write_document`. (`write_file` still permits it — a known, separately-tracked hole.)
- **Workspace partition** (enforced by `writeArtifact`): every write lands under `artifacts/` (published — non-empty `roles` required) or `scratch/` (private — roles forbidden). `write_file` may target either (roles default `["requested_output"]`); `screenshot`/`download` publish only (roles default `["evidence"]`, plus `requested_output` when the capture was explicitly asked for). Graders select deliverables via `requestedOutputs()` / the finders in `evals/grading/manifestVerification.ts` — never from raw `manifest.artifacts`.
- **Every production run states a typed output contract, unconditionally.** `runTask` always forces `submissionProtocol: true`: completion requires an explicit, exclusive `submit_for_verification` call (validated by `validateWorkerResponse`) — a response with zero `tool_use` blocks is an INVALID working response, not completion, and the loop still never consults `stop_reason`. Before a contract exists, every tool but `set_output_contract` is refused (the contract-first gate); `--contract-author <initializer|worker>` picks who states it (default `initializer`), feeding the same store, code checks, and verifier either way. The old prose `INTENT.md`/`CONTRACT.md` authoring mode described by `SYSTEM_PROMPT` is gone along with the judge-less path it served — production runs get the per-run `workerProtocolBrief` instead, which explicitly tells the model to disregard that paragraph.
- Declare `getAccess(input)` on every tool — it is mandatory on `ToolDef`, not optional. It drives the scheduler, deriving `{reads, writes, exclusive}` from validated input (parallel calls ≤5; conflicting writes serialize; read/read never conflicts). There is no `readOnly` field anymore. A tool with no `getAccess` is a type error at authoring time; one whose declaration throws at runtime is treated as exclusive — degrading to serial execution, never to unsafe parallelism.

## Repo-specific mechanics agents otherwise miss

<!-- metadata: gotchas, environment, workflow -->

- **No dotenv loader.** `.env` (gitignored) holds `ANTHROPIC_API_KEY`, `LANGFUSE_*`, and `GITHUB_TOKEN`; run key-needing scripts as `npx tsx --env-file=.env <script>`. Never read or print the values. Two entry points are exempt because they load it themselves: `sherlock` (its own loader, `src/tui/main.tsx`) and `npm run evals` (`--env-file-if-exists=.env` in the script). **`evals/runners/regrade.ts` is not** — it still needs the flag by hand.
- **An eval that grades GitHub needs `GITHUB_TOKEN`.** Unauthenticated oracles get 60 requests/hour, which a k=3 batch exhausts mid-run. The failure is disguised: the agent run *succeeds* and the grader then dies on HTTP 403, so the report shows low accuracy and looks like an agent regression. Read the log ordering — a trial that prints `run finished` and *then* `errored` failed in the grader, not the agent. Recover with `npx tsx --env-file=.env evals/runners/regrade.ts "<task>:<dir1>,<dir2>,<dir3>"`, promptly, since regrading refetches live ground truth.
- **No build step** — `tsx` runs TypeScript directly; `tsconfig` is `noEmit`. Typecheck covers `src`, `demos`, `evals`, `tests`.
- `npm test` is hermetic (loopback fixture server in `tests/fixtures/server.ts`) but **requires a local Chrome install**; oracle network functions are never called in tests. Browser tool suites register their Chrome/fixture/run-dir lifecycle through `tests/helpers/browserToolSuite.ts`.
- Interactive and authenticated runs launch headed (`channel: 'chrome'`) with the persistent `chrome-profile/` (gitignored). Normal eval trials each launch headless with their own temporary profile. Profile paths must be absolute; only one process may own the persistent profile.
- Per-trial profile cleanup only runs on a normal exit, so `createEvalBrowserRuntime` also sweeps `$TMPDIR` for `evidence-agent-eval-chrome-*` directories untouched for 4+ hours (a killed batch used to leak them forever — ~260 MB across two days once filled the disk). mtime, not age alone, is what protects a concurrently running batch: live Chrome writes to its profile constantly. The sweep only ever warns.
- Tool results over 50 KB are offloaded to `runs/<id>/scratch/tool-output/` with a preview — that's the designed behavior, not a bug.
- The TUI's `artifact_published` event is **derived, not authoritative**: the tracing seam (`src/tui/bridge/tuiTracing.ts`) diffs `manifest.json` after each tool execution and emits one event per new-or-changed published entry. The manifest remains the single source of truth; nothing model-visible changed — the prompt prefix stays byte-stable and tool-result shapes are untouched — so evals are unaffected.
- SEC-related code: their edge 403s any non-plain User-Agent and most non-browser HTTP clients; the oracle's `Name email` UA in `evals/datasets/edgar/oracle/edgarClient.ts` is load-bearing.
- Defaults that matter when debugging runs: model `claude-sonnet-5`, `maxTurns` 24, token budget 250k (all in `src/cli/runTask.ts` / `src/model/callModel.ts`, overridable per run via `RunTaskConfig`).
- Planning docs are part of the workflow: failure analysis goes in `.agents/planning/.../implementation/baseline-failure-log.md`; commit scoped `git add` after each verified step, planning dir included.

## Current state (2026-08-12)

<!-- metadata: status, work-queue -->

Checkpoint 1 complete; the post-F1–F4 easy re-baseline passes 3/3 tasks at k=3 (details in `docs/reports/2026-08-11-rebaseline.md`). All eleven design-doc eval tasks now have loadable dataset packages; the six added on 2026-08-12 have not been baseline-run. The initializer/worker typed output-contract idea, once deferred, has since landed and is now the run's unconditional protocol (see the "Binding project rules" contract bullet above). **Do not re-baseline without the user's direction.**

Eval execution supports parallel normal trials with isolated headless Chrome profiles and a separate serial authenticated lane. `task.json` controls the policy through optional boolean `headed` (renamed from `requiresAuth`; the loader throws if it sees the old name); never infer it from task names or task text.

## Custom Instructions

<!-- This section is maintained by developers and agents during day-to-day work.
     It is NOT auto-generated by codebase-summary and MUST be preserved during refreshes.
     Add project-specific conventions, gotchas, and workflow requirements here. -->
