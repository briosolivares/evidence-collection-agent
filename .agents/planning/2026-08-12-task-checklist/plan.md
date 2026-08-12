# Task V2–Style Run Checklist — Incremental Implementation Plan

**Date:** 2026-08-12

**Branch:** `feat/task-checklist`

**Reference inspected:** `/Users/briosolivares/Desktop/Code/claude-code`

**Scope:** one run-scoped, tool-managed checklist plus its minimal live Ink UI. This plan does not introduce a scheduler, TodoWrite, shared task lists, or multi-agent behavior.

## Implementation checklist

- [x] Step 1: Add the run-scoped checklist schema, durable store, bootstrap, and provenance behavior.
- [x] Step 2: Add `TaskCreate`, `TaskList`, `TaskGet`, and `TaskUpdate`; register them and teach the model to use them.
- [ ] Step 3: Add a disk-backed checklist subscription for the current run.
- [ ] Step 4: Render the checklist in Sherlock while running and above the composer while idle.
- [ ] Step 5: Lock the contract in documentation and complete end-to-end validation.

## Codebase-specific starting point

The plan is based on the current implementation, including the Ink TUI and the `scratch/` / `artifacts/` split:

- `src/cli/runTask.ts` is the composition root. It creates a new run, calls `initManifest`, builds the production registry, and invokes `runAgentLoop`.
- `src/loop/agentLoop.ts` already has the desired continuation rule: it repeats only when an assistant response contains `tool_use` blocks. Checklist state must not be consulted here.
- `src/tools/registry.ts` passes `ToolCtx { runDir, browser? }` to tools. The checklist tools can therefore resolve their list from `runDir` without adding per-run values to the prompt.
- `src/tools/index.ts` owns deterministic production tool order. `TaskList` and `TaskGet` must be marked `readOnly: true`; `TaskCreate` and `TaskUpdate` must be state-changing scheduler barriers.
- `src/run/artifacts.ts` is the provenance write chokepoint and now enforces that ordinary writes land only under `scratch/` or `artifacts/`. Extend that chokepoint with one explicit internal `checklist/` state class; checklist writes must still pass through `writeArtifact`, but only the checklist store may opt into that class and the resulting entries carry no artifact roles.
- `write_file` only permits model-supplied freeform writes under `scratch/` or `artifacts/`. Keep that restriction: the model may mutate `checklist/` only through the four task tools.
- `src/tui/bridge/tuiTracing.ts` emits `run_dir` before the first tool executes. That is the existing seam by which the UI can learn which `runs/<run-id>/checklist/` directory to watch.
- `src/tui/components/App.tsx` owns the session store and mounts `LiveRegion` plus the composer. `StatusLine.tsx` is the correct running-state mount; `App.tsx`, immediately above `Composer`, is the correct idle mount.
- `src/tui/store/state.ts` currently drops `live.runDir` when a run ends. A separate last/current checklist run-directory field is needed if an incomplete list is to remain visible above the prompt after cancellation, failure, or early budget termination.
- The repository has no agent-conversation resume command today. “Resume” in this scope therefore means that the checklist API and UI can reopen an existing run directory and reconstruct state solely from `checklist/*.json`; this work must not pretend to add full conversation reconstruction or a new resume workflow.

## Target contract

### Run layout

```text
runs/<run-id>/
  checklist/             # tool-managed structured run state; never a deliverable
    .highwatermark       # hidden numeric-ID counter; not a task
    1.json               # one JSON file per live task
    2.json
  scratch/               # unchanged: private model working files
  artifacts/             # unchanged: published outputs/evidence only
  manifest.json
  transcript.jsonl
  metrics.json
```

The hidden high-water mark follows Claude Code’s numeric-ID behavior and prevents a deleted task ID from being reused. No lock file or cross-process claim protocol is needed: this agent is single-agent, and the existing scheduler serializes state-changing tools. `TaskCreate` calls emitted together are therefore executed in order.

Checklist JSON is durable and independently reloadable. It is also hashed through the existing manifest because the binding repository rule requires every tool write to pass through `writeArtifact`. Extend `ArtifactMeta` with an internal-only discriminator such as `managedState: 'checklist'`: normalized `checklist/...` paths require that discriminator and forbid `roles`/`sourceUrl`; the discriminator is forbidden for `scratch/` and `artifacts/`. This does **not** make checklist state a published artifact: checklist entries live outside `artifacts/` and have no `roles`. Graders continue to select deliverables only from entries carrying `requested_output`.

### Task schema

```ts
type TaskStatus = 'pending' | 'in_progress' | 'completed';

interface ChecklistTask {
  id: string;             // positive decimal ID, e.g. "1"
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;    // e.g. "Collecting filing evidence"
  metadata?: {
    expectedArtifacts?: string[]; // optional evidence-agent convention
    [key: string]: unknown;
  };
}
```

Use one shared strict Zod schema for reads and writes. `expectedArtifacts`, when supplied, contains run-relative `artifacts/...` paths. A transition to `completed` must reject with a steering message if any promised path is absent or is not recorded as a published `requested_output`; the task stays unchanged. This is the only evidence-agent-specific completion check. General “work is truly complete” remains prompt guidance because it cannot be inferred reliably at runtime.

`deleted` is accepted only by `TaskUpdate` as an action. It removes `<id>.json` and the corresponding manifest entry; it is never written as a task status. The high-water mark remains, so later creates cannot recycle the ID.

### Store interface

Add `src/run/checklist.ts` with a narrow run-scoped API:

```ts
createChecklistTask(runDir, input): ChecklistTask
listChecklistTasks(runDir): ChecklistTask[]
getChecklistTask(runDir, taskId): ChecklistTask | undefined
updateChecklistTask(runDir, taskId, patch): ChecklistTask
deleteChecklistTask(runDir, taskId): boolean
onChecklistUpdated(listener: (runDir: string) => void): () => void
```

Rules for this module:

- Build every task path internally from a positive-decimal `taskId`; no tool accepts a checklist file path.
- Use `resolveRunPath` for reads/deletes and `writeArtifact(..., { managedState: 'checklist' })` for `.highwatermark` and JSON writes.
- Add a confined `deleteTrackedRunFile` helper in `src/run/artifacts.ts` with the same checklist-state discriminator, so deletion removes both the file and its manifest entry. Do not expose arbitrary deletion to the model.
- Pretty-print JSON with a trailing newline for stable, auditable diffs.
- Sort lists by numeric ID, not directory iteration order.
- Validate every file on read. Tool calls get a model-readable error for malformed JSON/schema instead of silently losing a task; the TUI keeps its last good snapshot and retries on the next invalidation/poll.
- Emit `onChecklistUpdated(runDir)` only after a successful create, update, or delete. The event is an invalidation signal only; listeners must reread disk, preserving disk as the source of truth.
- Do not place checklist contents into the conversation automatically.

### Model-facing tool API

Use Claude Code’s familiar model-facing names exactly, while following this repository’s one-directory-per-tool convention (`src/tools/taskCreate/`, etc.).

| Tool | Input | Result behavior | Scheduler flag |
| --- | --- | --- | --- |
| `TaskCreate` | `subject`, `description`, optional `activeForm`, optional `metadata` | Creates one `pending` task and returns its ID/subject plus a reminder to mark it `in_progress` before work | `readOnly: false` |
| `TaskList` | strict empty object | Returns compact lines such as `#1 [in_progress] Collect filing evidence`, numerically sorted; `No checklist tasks found` when empty | `readOnly: true` |
| `TaskGet` | `taskId` | Returns the complete current task, including `activeForm` and `metadata`; missing ID is a clear nonfatal result | `readOnly: true` |
| `TaskUpdate` | `taskId` plus at least one of `subject`, `description`, `activeForm`, `metadata`, or `status`; status also accepts action `deleted` | Updates only the named task. Completion result says to call `TaskList` immediately; deletion removes the file | `readOnly: false` |

`TaskUpdate.metadata` merges keys into existing metadata; a `null` value removes a key. Regular statuses may be corrected or reopened; do not hard-code a transition graph. Specifically, do not reject a second `in_progress` task at runtime—“prefer one” is prompt guidance, as requested.

All four tool descriptions and schemas remain static and deterministic. The root schema must remain `type: object` after `z.toJSONSchema`, preserving the production guard in `src/tools/index.test.ts`.

### Prompt text and nudges

Extend the static `SYSTEM_PROMPT` with guidance equivalent to:

> For non-trivial work with three or more meaningful steps, use TaskCreate to make a concise checklist; skip it for straightforward tasks. Before starting an item, mark it in_progress. Prefer only one in_progress item at a time. Mark an item completed immediately after its work and promised artifacts are fully done; do not batch completions. After each completion, call TaskList to choose the next pending item. The checklist tracks progress but never controls the agent loop, and it does not replace writing and verifying required artifacts.

Tool descriptions reinforce the same behavior:

- `TaskCreate`: when to create versus skip; check `TaskList` first to avoid duplicates.
- `TaskUpdate`: mark `in_progress` before work; complete only after implementation/evidence and required tests are done; keep the task open after errors or partial work; use `deleted` only for mistakes/superseded items.
- `TaskList`: call after completing an item and before finalizing a non-trivial run.
- `TaskGet`: fetch current details before changing an older task.

Use concise result nudges, not control flow:

- Create: `Task #<id> created ... Mark it in_progress before starting it.`
- Non-completion update: `Task #<id> updated ... Keep the checklist current as work proceeds.`
- Completion: `Task #<id> completed. Call TaskList now; do not batch task completions.`
- Delete: `Task #<id> deleted.`

Do not append the “next pending task” to later prompts. The model sees checklist state only when it calls a task tool.

### TUI behavior

Add a single run-aware disk subscription, owned by `App`, rather than duplicating watchers in `StatusLine` and the idle footer:

1. `App` passes the active/last checklist `runDir` into `useRunChecklist`.
2. The subscription immediately calls `listChecklistTasks(runDir)`.
3. It subscribes to `onChecklistUpdated` for same-process writes and `fs.watch` on `<runDir>/checklist` for disk changes, with a short (about 50 ms) debounce.
4. While unresolved tasks exist, a low-frequency fallback poll (about 5 s) protects against missed filesystem events.
5. Every invalidation reloads from disk; task objects are never copied from tool-result text or model prose.
6. Empty lists are hidden. When all tasks become completed, show the completed state for about 5 seconds, then hide the UI **without deleting any task files**. A later create/update makes it visible again.
7. Cleanup closes the watcher, timers, and update subscription when the run changes or `App` unmounts.

Render a compact `src/tui/components/TaskChecklist.tsx`:

- During a run, mount it from `StatusLine` as one visual status tree rather than as a separate card. When an item is `in_progress`, the animated headline uses `activeForm ?? subject`; Sherlock’s rotating working word remains the fallback only when no task is active.
- Keep elapsed time and token usage on the right side of that headline at normal widths (`(9s · ↓ 209 tokens)`); wrap them to the existing muted metadata line at narrow widths. Cancellation still replaces the headline with `Wrapping up…`.
- Render the current task first as an indented tree child (`└` + a filled accent square + bold `subject`). Render the other tasks below it in numeric order: green check + dim subject for completed, hollow square + normal subject for pending. Do not strike completed text—the checkmark and muted color are sufficient.
- Cap the expanded tree to the available terminal height/width. Truncate subjects with an ellipsis and replace hidden rows with status-aware summaries such as `… +1 completed` or `… +3 pending · 2 completed`.
- Use the existing `theme.primary`, `theme.success`, and `theme.muted` tokens rather than introducing screenshot-specific colors. Preserve the existing composer border and spacing immediately below the status region.
- When the session is idle and the last run still has an incomplete/temporarily-visible list, mount the standalone form in `App.tsx` immediately above `Composer`.
- Do not render the idle checklist behind `/runs` or `/evals` overlays.
- Add semantic activity text for the four tools in `src/tui/store/semantic.ts` (for example, `Adding a checklist item`, `Updating task #2`, `Reviewing the checklist`). These are ordinary activity lines and are not the checklist’s data source.

Target running-state shape (colors come from Sherlock’s theme):

```text
✻ Running validation and writing report…  (9s · ↓ 209 tokens)
  └ ■ Step 6: Validation (typecheck, tests, smoke + medium…)
    ✓ Step 1: Manifest schema + write-path validation
    ✓ Step 2: Producers
    ✓ Step 3: System prompt workspace contract
    ✓ Step 4: Grading layer + regression tests
    … +1 completed
```

The reducer stores a `checklistRunDir` separate from `live`:

- Clear the previous value on `run_started` so a new run never inherits another run’s checklist.
- Set it on `run_dir` (emitted by `tuiTracing` before a tool writes).
- Preserve it when `live` is removed at completion/cancellation/failure, allowing the idle display for unfinished work.
- A later run replaces it. There is still exactly one checklist per run and no shared cross-run state.

## Incremental implementation steps

### Step 1: Add durable checklist storage and run bootstrap

**Objective:** Establish a safe, auditable Task V2 disk model before exposing model-facing tools.

**Implementation:**

1. Export `CHECKLIST_DIR` and create it alongside `scratch/` and `artifacts/` in `initManifest`.
2. Extend `writeArtifact`’s current workspace-partition assertion with the explicit internal checklist-state discriminator described above. Ordinary callers still have exactly the existing two choices; `checklist/` is not a third freeform model workspace.
3. Add the schemas and store operations in `src/run/checklist.ts`, including the numeric high-water mark, deterministic ordering, disk validation, metadata merge behavior, expected-artifact completion check, and update notification signal.
4. Add `deleteTrackedRunFile` to `src/run/artifacts.ts`; it must require the checklist discriminator, use `resolveRunPath`, load the manifest before mutation, remove exactly one checklist file, remove its manifest entry, and leave unrelated provenance untouched.
5. Ensure checklist writes have no `roles`; keep `write_file` rejecting `checklist/...`, proving checklist files cannot be freeform model notes.
6. Update `src/tui/runScanner.ts` to show only published `artifacts/` entries in `/runs` summaries, so manifest-indexed checklist and scratch state is never mislabeled as a deliverable.

**Tests added/updated:**

- `src/run/checklist.test.ts`: schema validation; create IDs; numeric list ordering; get; partial update; metadata merge/delete; `pending → in_progress → completed`; reopening; two simultaneous `in_progress` tasks allowed; missing-task behavior; delete removes the JSON and does not reuse its ID.
- Completion tests: a task with missing/unpublished `metadata.expectedArtifacts` cannot complete and remains unchanged; it completes after the requested-output manifest entry exists.
- Corrupt/malformed task files fail with the task path in the error.
- `src/run/artifacts.test.ts`: `initManifest` creates all three directories; checklist writes require the internal discriminator; ordinary writes are still restricted to the existing two workspaces; tracked deletion updates the manifest and cannot escape the run.
- `src/tools/writeFile/writeFile.test.ts`: an explicit `checklist/1.json` write is rejected and writes nothing.
- `tests/tui/run-scanner.test.ts`: `/runs` summary includes published artifacts but excludes scratch and checklist manifest entries.
- Resume-from-disk test: write tasks, discard all in-memory references, and call the store again with the same existing `runDir`; the same task IDs, fields, and statuses load from JSON.

**Demo after this step:** A hermetic test fixture creates a run and three task files, updates one, deletes another, then displays the surviving JSON and matching manifest hashes. `scratch/` and `artifacts/` behavior is unchanged.

### Step 2: Add the four tools, prompt guidance, and ordinary loop integration

**Objective:** Give the model the complete single-task CRUD surface and make it use that surface without changing loop control.

**Implementation:**

1. Add one directory and colocated test for each tool: `taskCreate`, `taskList`, `taskGet`, and `taskUpdate`.
2. Implement the strict schemas, result formatting, tool descriptions, and nudges above. The tools call only `src/run/checklist.ts`; they never edit paths directly.
3. Export a deterministic `checklistTools` array from `src/tools/index.ts` and append it after the ten default tools but before optional `browser_batch`. Both production profiles receive the checklist tools.
4. Update `SYSTEM_PROMPT` with the static checklist paragraph. Do not include a run ID, current tasks, timestamps, or any other per-run text.
5. Add semantic names for checklist tool activity, but do not special-case them in `runAgentLoop`.
6. Update comments/documentation in the composition root from “ten tools” to the resulting production surface where applicable.

**Tests added/updated:**

- Per-tool pipeline tests cover valid calls, strict invalid input, not-found behavior, create/list/get/update/delete, metadata, status results, and the exact completion/List nudge.
- Registry tests assert the exact stable order, `readOnly` flags, no duplicate names, and top-level object JSON schemas for both profiles.
- `src/cli/systemPrompt.test.ts` asserts the create-versus-skip, one-in-progress guidance, immediate completion, `TaskList` follow-up, and unchanged workspace roles. Its byte-stable-prefix test now includes the four deterministic task tools.
- A scripted `runTask` integration test emits `TaskCreate`/`TaskUpdate` tool uses and then a zero-tool response. Assert that the ordinary loop makes the next model calls, checklist JSON is updated, transcript events are normal tool events, and the run completes only on the zero-tool response.
- Keep `src/loop/agentLoop.ts` unchanged; its existing tool-use completion tests remain the regression proof that checklist state cannot drive another turn.

**Demo after this step:** A fake-model run creates a three-item checklist, advances one task, writes a promised artifact, completes the task, calls `TaskList`, and exits normally. The run directory contains separate `checklist/`, `scratch/`, and `artifacts/` trees.

### Step 3: Subscribe the TUI to checklist files

**Objective:** Make disk-backed task updates observable in real time without using assistant text or waiting for a later model turn.

**Implementation:**

1. Add `src/tui/hooks/useRunChecklist.ts` (and a small testable external-store helper if useful) implementing immediate load, `onChecklistUpdated`, `fs.watch`, debounce, incomplete-only fallback polling, last-good-snapshot error handling, all-complete hide timing, and cleanup.
2. Extend `SessionState`/the reducer with `checklistRunDir` using the lifecycle rules above. Do not put the task array in the reducer; the array comes from the disk subscription.
3. Have `App` create exactly one subscription and pass its snapshot to running and idle render sites.

**Tests added/updated:**

- Reducer tests prove run A’s path is preserved on end, cleared when run B starts, and never shared with run B.
- Subscription tests cover initial load from existing disk, same-process invalidation after a real checklist tool write, an external filesystem write observed through the watcher, debounce/coalescing, watcher cleanup, missed-event polling, and last-good behavior on transient invalid JSON.
- Fake-timer tests prove empty lists hide immediately and all-completed lists hide after about five seconds without deleting files.

**Demo after this step:** Render a tiny test consumer against a temporary run, invoke the real `TaskCreate` and `TaskUpdate` executors, and watch the consumer’s text change after each disk write without passing task data through a UI event.

### Step 4: Render the running and idle checklist

**Objective:** Expose current progress in Sherlock’s existing live/status layout with minimal visual footprint.

**Implementation:**

1. Add `TaskChecklist.tsx` with compact and standalone variants, the tree connectors/status glyphs above, in-progress priority, stable numeric ordering for remaining rows, terminal-aware truncation, and status-aware overflow summaries.
2. Thread the snapshot from `App` through `LiveRegion` to `StatusLine`; make `activeForm` the running headline when present and mount the compact tree directly beneath it, with metrics inline when width permits.
3. Mount the standalone variant above `Composer` only when idle and visible. Keep overlays and eval menus in control of their current screen regions.
4. Extend the semantic activity table/tests from ten tools to fourteen core tools.

**Tests added/updated:**

- Component tests: active `activeForm` headline; bold current subject with tree connector/filled square; completed checkmarks with muted text; pending hollow squares; numeric row order; status-aware overflow copy; narrow-width truncation and metric wrapping; compact versus standalone rendering.
- App integration test: use a temporary initialized run and the real task tools; after `run_dir`, tool writes appear in the current Ink frame while the run is active.
- Idle integration tests: an incomplete checklist remains above the composer after cancellation/budget exhaustion; an all-completed list briefly shows then hides; starting another run removes the previous list.
- Update the current status-line and smoke snapshots at 80 and 44 columns, checking that token/elapsed/cancellation output and composer behavior remain intact.

**Demo after this step:** In the TUI, a run shows an active headline such as `Running validation and writing report…`, its bold current step as a tree child, completed/pending rows with status glyphs, an overflow summary, and inline elapsed/token metadata as space allows. After an interrupted run, remaining tasks stay above the input; after all tasks finish, the list disappears after the short completion window while JSON remains on disk.

### Step 5: Document and validate the finished contract

**Objective:** Make the new third run area and fourteen-tool core discoverable, and verify the feature without broadening into an eval experiment.

**Implementation:**

1. Update `README.md` and `AGENTS.md` run-layout/tool-count text to distinguish `checklist/` from `scratch/` and `artifacts/`, and revise the workspace-partition rule precisely: freeform model writes remain limited to the existing two workspaces, while internal task tools may write only managed checklist state through the provenance chokepoint.
2. Update the relevant generated-summary source documents (`.agents/summary/architecture.md`, `components.md`, `data_models.md`, `interfaces.md`, and `workflows.md`) if this repository’s documentation workflow expects them to remain current.
3. Run `npm run typecheck` and `npm test` after the step’s scoped changes, fixing only checklist-related regressions.
4. Perform one non-trivial interactive smoke only when token-bearing execution is approved: verify Task tool calls occur, the TUI refreshes during the run, promised artifacts exist before completion, and the final response still ends through zero `tool_use` blocks.
5. Do **not** re-baseline eval datasets as part of this feature; the repository explicitly requires separate user direction for re-baselining.

**Tests/acceptance checks:**

- Full typecheck and hermetic suite pass.
- Inspect one fixture run to confirm task files are valid, manifest hashes match, deleted tasks are absent, and published artifact roles are unchanged.
- Inspect the scripted transcript to confirm there is no injected next-task message and no checklist-driven loop branch.
- Confirm no checklist task is selected by graders as a requested output and `/runs` does not display checklist files as deliverables.

**Demo after this step:** A fresh non-trivial run visibly progresses through a Task V2 checklist, leaves durable checklist JSON beside—but never inside—its working files and deliverables, and completes through the unchanged loop contract.

## Claude Code behavior: copied versus intentionally omitted

### Copy

- Per-task JSON files, numeric IDs, a high-water mark, and disk as the source of truth.
- Simplified `id`, `subject`, `description`, `status`, optional `activeForm`, and optional metadata.
- `TaskCreate`, `TaskList`, `TaskGet`, and single-task `TaskUpdate` rather than whole-list replacement.
- `pending`, `in_progress`, and `completed`; `deleted` as a removal action only.
- Static prompts for create-versus-skip, mark-in-progress-before-work, complete promptly, do not batch completions, and call `TaskList` after completion.
- Same-process update notification plus filesystem watching, debounce, and fallback polling.
- Expanded list while working, compact current/next information, and a standalone idle list.
- A short all-complete visibility delay.
- Checklist tools as ordinary tools; tool-result nudges are content, not control flow.

### Omit or adapt deliberately

- No TodoWrite/V1 whole-array replacement and no in-memory `AppState.todos`.
- No `~/.claude/tasks`, `CLAUDE_CODE_TASK_LIST_ID`, session/team/env list selection, or feature flag. The current `runDir` is the only list identity.
- No owners, claims, mailboxes, teammates, swarms, task assignment UI, or task-watcher auto-submission.
- No `blocks`, `blockedBy`, dependency graph, or blocked-task enforcement.
- No verification-agent nudge, task hooks, or stop-hook inspection.
- No cross-run shared checklist and no automatic copying between runs.
- No “next task” injection and no scheduler that auto-pops work into the prompt.
- No hard runtime “only one in_progress” constraint.
- No deletion/reset of completed task files after the UI hides; this repository needs checklist state to survive for audit/resume.
- No multi-process lock machinery. The existing scheduler’s state-changing barriers are the single-agent serialization mechanism.
- No new full-run conversation resume feature. The store is resume-safe for any caller that reuses the same run directory; adding conversation restoration is outside this checklist scope.
- Claude Code’s `TaskListV2` team activity, owners, blockers, terminal-size sophistication, and teammate spinner tree are reduced to the single-agent compact list described above.

## Success criteria

- A scripted or approved live non-trivial run can create a multi-step list, mark one item `in_progress`, finish it, call `TaskList`, and advance remaining work.
- Every live task is a schema-valid `runs/<run-id>/checklist/<id>.json`; no checklist JSON appears under `scratch/` or `artifacts/`.
- Checklist writes and deletions keep manifest provenance valid without adding artifact roles or changing requested-output selection.
- Restarting the checklist reader against the same run directory reconstructs task state from disk with no conversation dependency.
- Tool result blocks continue the existing loop exactly like browser/file tool results; only an assistant response with zero `tool_use` blocks completes the run.
- Sherlock shows the current `in_progress` item (`activeForm` preferred) plus remaining work while running, and shows unfinished work above the prompt when idle.
- TUI refresh is caused by disk reload after tool writes/watch invalidation, never by parsing model prose.
- All-completed UI hides without deleting durable task files.
- `scratch/` remains private working space and `artifacts/` remains published deliverables/evidence; their tool semantics and grader roles do not change.
- No non-goal listed in this plan is implemented, and no eval re-baseline is run as part of the feature.

## Main risks and controls

- **Manifest/checklist tension:** repository rules require tool writes to be hashed and `writeArtifact` currently rejects every third root, while checklist files are not artifacts. Control: require an internal checklist-state discriminator at the chokepoint, keep `write_file` restricted to `scratch/`/`artifacts/`, omit roles, keep grader selection role-based, filter `/runs` to published files, and test hash verification/deletion.
- **Watcher races:** `run_dir` is emitted immediately before first tool execution, so the first write can beat React effect setup. Control: the subscription always performs an initial disk load; notifications and watch events are invalidations, not the only source of state.
- **Prompt-cache regression:** four definitions and system guidance intentionally change the prefix once. Control: fixed registration order, static descriptions, top-level object schemas, and the existing cross-task byte-stability test.
- **Checklist UI damaging Ink’s `<Static>` contract:** tasks change over time and must never become transcript items. Control: render them only in the dynamic `LiveRegion`/footer area, with a disk snapshot held outside the append-only transcript.
- **False completion:** a model may mark abstract work complete too early. Control: strong prompt/tool nudges plus a hard check only for explicitly declared `metadata.expectedArtifacts`; do not invent unreliable generalized verification.
- **Scope creep into resume/scheduling:** the current application has neither conversation restore nor a task scheduler. Control: test reload-by-runDir, leave `agentLoop.ts` untouched, and reject any design that injects or auto-submits the next task.
