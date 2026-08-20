# AGENTS.md

Navigation and binding rules for agents working in this repository. Start with
[the current implementation plan](docs/browser-agent-v3/implementation-plan.md)
for live progress and [the design doc](docs/browser-agent-v3/sherlock-v3-design-doc.md)
for rationale (the docs keep their historical v3 naming). `.agents/summary/`
is the concise architecture reference; historical checkpoint-1 planning and
reports remain useful only as history.

## What this is

Sherlock is a general browser agent for audit evidence collection. The single
production composition root is `src/agent/runTask.ts`. It runs a bounded
contract initializer, one persistent sequential worker session, deterministic
finish checks, and a fresh read-only verifier under the durable lifecycle in
`src/agent/lifecycle.ts` (`runAgent`).

The worker sees exactly eight tools in the frozen order declared by
`WORKER_TOOL_ORDER`: `browser_execute`, `publish_artifact`, `read_file`,
`write_file`, `edit_file`, `bash`, `ask_user`, and `finish`. Each tool lives in
its own folder under `src/tools/`. Browser work goes through the
engine-neutral `BrowserController`; `BrowserSessionProvider` selects local
Chrome or Browserbase in `src/browser/provider.ts`.

Each run is a self-contained directory under `runs/`:

- `artifacts/`: published requested outputs and evidence;
- `scratch/`: private, hashed work, including `scratch/workspace/`;
- `harness/`: private checkpoint, lock, immutable contract, and recovery data;
- `manifest.json`: artifact roles, hashes, provenance, and lifecycle times;
- `transcript.jsonl` and `metrics.json`: durable execution projections.

Graders receive only `(runDir, oracleData)` and select deliverables exclusively
from manifest entries carrying `requested_output`.

| Subsystem | Entry point | Notes |
| --- | --- | --- |
| Composition | `src/agent/runTask.ts` | Only production model/tool/lifecycle wiring |
| Agent runtime | `src/agent/` | `lifecycle.ts` plus `initializer/`, `worker/`, `completion/`, `verifier/` stage folders and the durable checkpoint |
| System prompts | `src/prompts/*.md` | Markdown files loaded once per process by `src/prompts/index.ts` |
| Model-facing tools | `src/tools/<toolName>/` | One folder per worker tool; registry/pipeline plumbing at the root |
| Interactive TUI | `src/tui/main.tsx` (`npm run sherlock`) | Attaches to the user's local Chrome or uses Browserbase |
| Eval harness | `evals/runners/cli.ts` (`npm run evals -- --tasks <a,b> [--k N] [--concurrency N]`) | Parallel isolated normal lane plus serial headed lane |
| Provenance | `src/run/` | Atomic manifest/artifact transactions, reconciliation, budget, transcript |
| Browser login | `src/cli/login.ts` (`npm run login`) | Managed local profile or Browserbase Context |
| Remote smoke | `scripts/browserbaseSmoke.ts` | Live/billable; never part of `npm test` |

## Binding project rules

- **No task-specific logic.** Fix eval failures with general mechanisms, never
  task-name branches. Hidden evals make per-task tuning worthless.
- **The run directory is the product boundary.** Never grade a transcript or
  treat conversation text/scratch files as a deliverable.
- **Keep the cached prefix byte-stable.** `workerPrompt` (from
  `src/prompts/worker.md`) and `WORKER_API_TOOL_DEFS` are process-wide and
  deterministic. Task/config/run data belongs in conversation messages, not
  the static prefix.
- **Exact requested shapes are exact.** Named CSV columns mean precisely those
  columns in that order; extra columns fail.
- **One immutable contract.** The initializer alone calls
  `set_output_contract`, at most twice. The worker cannot revise it. The
  contract schema lives in `src/agent/initializer/outputContract.schema.ts`.
- **One completion protocol.** `finish` must be the only tool call in its
  response. It requests deterministic checks and fresh verification; it does
  not declare success. Prose or a zero-tool response never completes a run.
  Only verifier acceptance yields `verified`; every bounded failure is a
  truthful `incomplete` reason.
- **Worker tools execute sequentially.** Do not reintroduce the retired
  scheduler or access-key model. A run-owned busy-resource ledger globally
  gates calls and terminalization after a timed-out effect may still be
  running.
- **Publication is explicit.** `write_file` and `edit_file` write only private
  scratch files. `publish_artifact` is the sole worker publication boundary
  and requires nonempty `requested_output` and/or `evidence` roles.
- **Constrain every model path.** Use `resolveRunPath`; never permit a
  model-supplied path under `harness/` or to metadata files.
- **Workspace writes are the deliberate exception.** `bash` and
  `browser_execute` may create files directly under `scratch/workspace/`.
  Their lifecycle must run `syncScratchWorkspace()` so surviving regular
  files are hashed and deletions reconciled. Symlinks/special files fail.
- **`bash` is bounded but not sandboxed.** It is worker-only, foreground-only,
  package-install-free, and has no browser capability. It runs with the
  application's OS-user authority; do not describe it as a security boundary.
- **`browser_execute` never exposes a CDP connection capability.** The child
  talks to a protected parent helper; connection URLs and provider credentials
  must not enter model output, logs, artifacts, errors, or child environments.
  Raw target inventory/mutation is confined to run-owned pages, and the
  browser-global `Browser.*` domain is denied. A durable
  `javascriptPolicy: deny` disables the whole tool without changing the static
  tool prefix.
- **Crash safety is product behavior.** Checkpoint effect state before and
  after every call, preserve artifact-write journals, use parent-death
  watchdogs for child processes, and reclaim only pages marked for the same
  run. Never weaken no-follow, atomic-write, or resume-integrity checks.

## Browser and eval mechanics

- Provider selection is explicit: only
  `SHERLOCK_BROWSER_PROVIDER=browserbase` starts a billable remote session.
  Merely holding a Browserbase key never selects it.
- Interactive local `sherlock` uses **attached** Chrome. It preserves existing
  user tabs, owns/marks only task pages, and disconnects without closing the
  daily browser. Local evals, login, demos, and tests choose **managed** Chrome
  explicitly so they never touch ambient state.
- Attached setup accepts an explicit loopback
  `SHERLOCK_CHROME_CDP_ENDPOINT` or bounded Chrome discovery; the endpoint is a
  capability and must always be redacted.
- Normal eval trials run in parallel isolated headless browsers. A task with
  `headed: true` runs in the serial authenticated lane. `requiresLogin` enables
  the pre-batch login gate; never infer either policy from task text/name.
- Remote downloads return through Browserbase's API and are SHA-256 verified;
  uploads travel as bytes. Remote Chrome cannot reach local loopback fixtures.
- Do not run `npm run smoke:browserbase` or an eval re-baseline without user
  direction. GitHub-graded evals need `GITHUB_TOKEN` or the grader can 403 only
  after a correct agent run has finished.

## Repository mechanics agents otherwise miss

- There is no build step; `tsx` runs TypeScript and `tsconfig` is `noEmit`.
  `npm run typecheck` covers `src`, `demos`, `evals`, `scripts`, and `tests`.
- Tests live in `tests/`, mirroring the `src/` layout (`tests/agent/`,
  `tests/tools/`, ...); production `src/` contains no test files.
- `npm run format` applies Biome (formatter only, 100-character lines) to all
  ts/tsx/mjs sources.
- `npm test` is hermetic/network-free but requires local Chrome. Tests must
  pass `env: {}` to eval browser composition so a developer's exported
  provider variable cannot trigger Browserbase.
- `.env` is gitignored. Never read or print secret values. `sherlock`, evals,
  login, and agent load their supported env files; direct scripts usually need
  `npx tsx --env-file=.env ...`.
- The Browserbase CDP URL is more sensitive than diagnostics. Use
  `BrowserSessionDiagnostics`; keep `BROWSERBASE_API_KEY` in the execution
  denylist.
- The TUI's `artifact_published` event is derived by diffing the manifest after
  tool execution. The manifest remains authoritative.
- Defaults in `src/agent/runTask.ts` (`PRODUCTION_DEFAULTS`): model
  `claude-sonnet-5`, unbounded worker turns and tool calls, unbounded
  aggregate model tokens, 900k per-request context ceiling, and one hour wall
  time — wall time is the run's bound on research persistence. Model-visible
  tool output is bounded per result and per message, with complete oversized
  text offloaded under `scratch/tool-output/`; cumulative result bytes remain
  a metric, not a whole-run completion ceiling.
- Durable on-disk formats keep their historical names: the checkpoint version
  is 3 and `transcript.jsonl` event types keep their `v3_*` prefixes. Renaming
  those values breaks resume of existing run directories.
- Planning docs are part of the workflow. Track work in
  `docs/browser-agent-v3/implementation-plan.md`; use scoped commits and include
  the tracker after every verified step. Never edit
  `docs/architecture-whiteboard.html` unless explicitly asked.

## Current state (2026-08-20)

The runtime, attached-local cutover, public composition, TUI/eval adapters,
legacy-runtime retirement, and active documentation are complete. A structural
simplification pass dissolved the historical `src/v3/` layer into `src/agent/`
(stage folders per model role), moved the three system prompts to Markdown in
`src/prompts/`, gave durable Zod schemas dedicated `.schema.ts` files, made
`src/tools/` folder-per-tool, relocated all colocated tests to `tests/`, and
adopted Biome formatting. Production is 122 TypeScript/TSX files (~30.2k
lines) plus three browser-child/helper `.mjs` files (~1k lines) and the prompt
Markdown. The complete hermetic suite passes 147 files / 1,482 tests, and
typecheck is green.

## Custom Instructions

<!-- This section is maintained by developers and agents during day-to-day work.
     It is NOT auto-generated by codebase-summary and MUST be preserved during refreshes.
     Add project-specific conventions, gotchas, and workflow requirements here. -->
