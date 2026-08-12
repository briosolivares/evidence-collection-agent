# AGENTS.md

Navigation and ground rules for AI agents working in this repository. Deep documentation lives in `.agents/summary/` (start with [index.md](.agents/summary/index.md)); design rationale in `.agents/planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md`; current project state in `.agents/planning/evidence-collection-agent-checkpoint-1/implementation/handoff-state.md`.

## What this is

<!-- metadata: overview, subsystems, navigation -->

A browser agent for audit evidence collection: a minimal Claude Code–style loop (`src/loop/agentLoop.ts`) over fourteen zod-validated core tools (one directory per tool under `src/tools/`, grouped for registration by `src/tools/index.ts`), driving browser sessions through an engine-neutral `BrowserController` and acquiring them through `BrowserSessionProvider` (`src/browser/`). The current provider launches local visible Chrome via Playwright. Every run writes a self-contained directory under `runs/`, named `<date>_<time>_<task-slug>_<suffix>` in local time — `artifacts/` (published outputs and evidence, each manifest entry carrying `roles: requested_output|evidence`, both allowed on one file), `scratch/` (private agent working state, never graded or shown, still hashed), `checklist/` (durable structured task state managed only by checklist tools, never a deliverable, still hashed), plus `manifest.json` (SHA-256 provenance, exact UTC `startedAt`), `transcript.jsonl`, `metrics.json` — which is the product's output boundary; eval graders read only the run directory and select deliverables exclusively from `requested_output` entries under `artifacts/`.

| Subsystem | Entry point | Notes |
| --- | --- | --- |
| Composition root | `src/cli/runTask.ts` | The only place loop + model + tools + tracing are wired; both REPL and evals drive it |
| Interactive agent | `src/cli/repl.ts` (`npm run agent`) | One persistent Chrome per session; fresh tab per task |
| Eval harness | `evals/runners/cli.ts` (`npm run evals -- --tasks <a,b,c> [--k <n>]`) | Datasets in `evals/datasets/<name>/{task.json, oracle/, grader/}`; paths + defaults in `evals/config.ts`; results JSON in `evals/experiments/` |
| Model client | `src/model/` | Streaming always; thinking disabled; prompt caching via one `cache_control` breakpoint |
| Provenance | `src/run/` | `writeArtifact` and `resolveRunPath` are the only write/path chokepoints |
| Demos | `demos/01…14` | Build-order walkthrough; 09/14 spend real tokens; 10–14 need Chrome |

## Binding project rules

<!-- metadata: rules, constraints, conventions -->

- **No task-specific logic, ever.** Eval failures are fixed with general mechanisms (outline, tool results, prompt) — never `if (task === ...)`. There is a hidden eval set; per-task tuning is worthless.
- **Graders read only the run directory** (path + oracle data). Never point one at a transcript.
- **The prompt prefix must stay byte-stable**: `SYSTEM_PROMPT` is static and `toApiToolDefs` is deterministic; changes that vary the prefix per run break prompt caching (tests assert this).
- **Exact output schema ruling**: a task naming CSV columns means exactly those columns — graders enforce; extra columns fail.
- **No `bash` tool** in the agent, by security design (untrusted web content + shell = prompt-injection RCE). Don't add one.
- Every tool write goes through `writeArtifact` (hashing into the manifest); every model-supplied path through `resolveRunPath`. Tools must not write `manifest.json`, `transcript.jsonl`, or `metrics.json`. Checklist tools may write only their managed `checklist/` state through that same provenance chokepoint.
- **Workspace partition** (enforced by `writeArtifact`): freeform model writes land only under `artifacts/` (published — non-empty `roles` required) or `scratch/` (private — roles forbidden). `write_file` may target either (roles default `["requested_output"]`); `screenshot`/`download` publish only (roles default `["evidence"]`, plus `requested_output` when the capture was explicitly asked for). Only checklist tools may mutate managed `checklist/` state, which carries no artifact roles. Graders select deliverables via `requestedOutputs()` / the finders in `evals/grading/manifestVerification.ts` — only published `artifacts/` entries with `requested_output`, never raw `manifest.artifacts`.
- Completion = a model response with zero `tool_use` blocks; the loop never consults `stop_reason`.
- Mark new tools `readOnly` correctly — it drives the scheduler (parallel reads ≤5, state-changing calls are barriers). Unknown/unmarked ⇒ treated as state-changing.

## Repo-specific mechanics agents otherwise miss

<!-- metadata: gotchas, environment, workflow -->

- **No dotenv loader.** `.env` (gitignored) holds `ANTHROPIC_API_KEY` and `LANGFUSE_*`; run key-needing scripts as `npx tsx --env-file=.env <script>`. Never read or print the values.
- **No build step** — `tsx` runs TypeScript directly; `tsconfig` is `noEmit`. Typecheck covers `src`, `demos`, `evals`, `tests`.
- `npm test` is hermetic (loopback fixture server in `tests/fixtures/server.ts`) but **requires a local Chrome install**; oracle network functions are never called in tests. Browser tool suites register their Chrome/fixture/run-dir lifecycle through `tests/helpers/browserToolSuite.ts`.
- The browser launches headed (`channel: 'chrome'`) with the persistent profile `chrome-profile/` (gitignored) — headless is deliberately avoided for anti-bot posture. Profile paths must be absolute.
- Tool results over 50 KB are offloaded to `runs/<id>/scratch/tool-output/` with a preview — that's the designed behavior, not a bug.
- SEC-related code: their edge 403s any non-plain User-Agent and most non-browser HTTP clients; the oracle's `Name email` UA in `evals/datasets/edgar/oracle/edgarClient.ts` is load-bearing.
- Defaults that matter when debugging runs: model `claude-sonnet-5`, uncapped `maxTurns`, 900k per-request context ceiling (all in `src/cli/runTask.ts` / `src/model/callModel.ts`, overridable per run via `RunTaskConfig`).
- Planning docs are part of the workflow: failure analysis goes in `.agents/planning/.../implementation/baseline-failure-log.md`; commit scoped `git add` after each verified step, planning dir included.

## Current state (2026-08-12)

<!-- metadata: status, work-queue -->

Checkpoint 1 complete; the post-F1–F4 easy re-baseline passes 3/3 tasks at k=3 (details in `docs/reports/2026-08-11-rebaseline.md`). All eleven design-doc eval tasks now have loadable dataset packages; the six added on 2026-08-12 have not been baseline-run. The longer-term initializer/planner output-contract idea is deferred. **Do not re-baseline without the user's direction.**

## Custom Instructions

<!-- This section is maintained by developers and agents during day-to-day work.
     It is NOT auto-generated by codebase-summary and MUST be preserved during refreshes.
     Add project-specific conventions, gotchas, and workflow requirements here. -->
