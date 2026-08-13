# Browser Agent Local Code Execution — Step-by-Step Implementation Plan

**Status:** Proposed

**Date:** 2026-08-13

**Design source:** [Browser Agent Local Code Execution — Detailed Specification](./browser-agent-local-code-execution-spec.md)

**Implementation target:** `feat/judge-harness`, currently at `cb2e22d`

This document is authored and committed on `feat/browser-agent-code-execution`
so it can be reviewed separately. Port this specification and plan commit onto
`feat/judge-harness` before implementation. The target branch has
`runAgentLoop()` and the initializer → worker → judge cycle loop; it does not
yet have the later `WorkerSession`, `RunBudgetTracker`, output-contract, or
stable-observation work found on `feat/browser-agent-v2`. Those later branches
are not prerequisites for this plan.

## 1. Outcome

Implement worker-only `edit_file` and finite local `bash` tools, allow Bash
scripts to automate the selected local Chrome page through Playwright, and make
the worker resumable from durable run-directory state.

The implementation should stay close to the existing code:

- extend `writeArtifact()` and the existing scheduler instead of adding a
  second file or execution framework;
- add two optional methods directly to `BrowserController` instead of adding a
  lease, bridge, or capability object;
- let `bash.ts` coordinate the process helper, workspace synchronization, and
  browser refresh directly;
- let `runTask.ts` own checkpoint transitions and recovery rather than adding
  a runtime-manager class;
- keep the existing `write_file`, result-capping, transcript, manifest,
  judge-harness, and browser-tool paths intact.

## 2. Rules for the implementation

These rules apply to every step:

1. Do not add task-specific behavior.
2. Keep all model-supplied file paths behind `resolveRunPath()`.
3. Keep `writeArtifact()` as the byte-and-manifest write path for file tools
   and workspace reconciliation.
4. Treat `edit_file` and `bash` as state-changing scheduler barriers.
5. Keep Bash and file mutation out of initializer and judge model calls.
6. Keep tool registration and `SYSTEM_PROMPT` deterministic. Do not vary the
   tool list by task, workspace contents, or browser capability.
7. Do not add a remote sandbox, background commands, package installation,
   Windows support, receipts, or a Bash-specific output store.
8. Use fixed bounds from the specification; do not silently clamp invalid
   inputs.
9. Make each step a focused, reviewable commit after its tests pass. Stage only
   the files belonging to that step.
10. Do not run a live eval re-baseline without separate user direction.

Keep the new tools out of the production registry until Step 9. This lets the
implementation land in small tested pieces while changing the prompt prefix
only once, when both tool contracts and their recovery behavior are ready.

## 3. Implementation order

| Step | Deliverable                                                            | Depends on |
| ---- | ---------------------------------------------------------------------- | ---------- |
| 0    | Confirm the branch baseline and existing tests                         | —          |
| 1    | Add the small manifest operations needed by editing and reconciliation | 0          |
| 2    | Implement exact, byte-preserving `edit_file`                           | 1          |
| 3    | Reconcile `scratch/workspace` into the manifest                        | 1          |
| 4    | Implement bounded foreground process execution                         | 0          |
| 5    | Expose the selected local Chrome page to generated scripts             | 4          |
| 6    | Implement the worker-only `bash` tool                                  | 3, 4, 5    |
| 7    | Add durable checkpoint storage                                         | 1          |
| 8    | Checkpoint worker/scheduler transitions and implement resume           | 3, 6, 7    |
| 9    | Activate the tools, cancellation, prompt, and local startup wiring     | 2, 8       |
| 10   | Run end-to-end recovery tests and repository gates                     | 9          |

Steps 2, 3, 4, and 7 are mostly independent after their stated prerequisites.
Their commits may be prepared in parallel when different programmers own
disjoint files, but Steps 6 through 10 should integrate in order.

## 4. Step-by-step plan

### Step 0 — Confirm the baseline

#### Work

1. Confirm the implementation branch and worktree are clean except for the
   planning documents.
2. Confirm the target is `feat/judge-harness` at `cb2e22d` or record the newer
   target commit. If the branch moved, rerun the code-seam inspection before
   editing and update this plan only where the actual source changed.
3. Port the two documentation files onto the target branch without merging
   unrelated Browser V2 implementation commits.
4. Record the target commit and Node version in the implementation handoff.
5. Run the existing focused suites around the seams this feature will change:

   ```bash
   npm test -- src/run/artifacts.test.ts src/tools/pipeline.test.ts \
     src/loop/scheduler.test.ts src/loop/agentLoop.test.ts \
     src/browser/playwrightBrowserController.test.ts \
     src/harness/harness.test.ts src/cli/runTask.test.ts
   npm run typecheck
   ```

6. If a baseline test already fails, record it before changing code. Do not
   hide a pre-existing failure by weakening an assertion.

#### Complete when

- The starting state and any pre-existing failures are known.
- No production files have changed.

There is no implementation commit for this step.

### Step 1 — Add the required manifest operations

#### Files

- `src/run/artifacts.ts`
- `src/run/artifacts.test.ts`

#### Work

1. Export a production `readManifest(runDir)` function by promoting the
   existing private manifest reader. It must still fail loudly on a missing or
   invalid manifest.
2. Add `removeScratchArtifactEntry(runDir, relPath)`:
   - normalize through `resolveRunPath()`;
   - accept only a path under `scratch/`;
   - remove only the manifest entry, because the caller has already observed
     that the file is absent;
   - fail when asked to remove an `artifacts/` entry;
   - make a missing scratch entry a no-op so one reconciliation pass can be
     idempotent.
3. Add `verifyManifestFiles(runDir)` for recovery. It should verify that every
   entry resolves inside the run, exists as a regular non-symlink file, and
   matches its recorded SHA-256. Return normally only when all entries match;
   otherwise throw one error listing every mismatch found.
4. Keep manifest serialization in `artifacts.ts`; do not create another
   manifest repository or storage class.

#### Tests

- Reading returns the existing manifest shape without mutating it.
- Scratch-entry removal preserves every unrelated entry.
- Removing an artifact entry or an escaping path fails.
- Repeating a scratch removal is harmless.
- Verification detects missing files, symlinks, and byte/hash mismatches.
- Existing write and role tests remain unchanged.

#### Complete when

The artifact module exposes exactly the operations required by `edit_file`,
workspace synchronization, and resume, with no second manifest abstraction.

**Suggested commit:** `run: add manifest reconciliation primitives`

### Step 2 — Implement exact `edit_file`

#### Files

- `src/tools/editFile/editFile.ts`
- `src/tools/editFile/editFile.test.ts`
- `src/tools/index.ts` only for exports; do not register the tool yet

#### Work

1. Define the strict Zod input schema with exactly:

   ```ts
   {
     file_path: string;
     old_string: string;
     new_string: string;
     replace_all?: boolean;
   }
   ```

2. Mark the tool `readOnly: false`.
3. In `execute`, resolve and revalidate the path at execution time. Require an
   existing regular non-symlink file under `artifacts/` or `scratch/`.
4. Reject a file larger than 64 MiB before allocating its contents.
5. Read bytes, decode as UTF-8, and prove byte stability by re-encoding before
   editing. Preserve a UTF-8 BOM; reject invalid or unsupported encodings.
6. Reject an empty `old_string` and `old_string === new_string`.
7. Count exact non-overlapping matches without newline, whitespace, quote,
   Unicode, or indentation normalization.
8. Fail on zero matches. With `replace_all` omitted or false, fail unless the
   count is exactly one. With `replace_all: true`, replace all matches.
9. Use literal replacement semantics so `$&`, `$1`, and similar text in
   `new_string` stays literal.
10. Keep the final read, validation, replacement, and `writeArtifact()` call in
    one synchronous critical section.
11. For a scratch file, write without roles. For a published artifact, require
    its existing manifest entry, preserve `roles`, and omit the old
    `sourceUrl`. If `completionStatus` is present on the target branch by
    implementation time, omit that stale field too.
12. Return only the normalized `file_path` and `replacement_count`.

#### Tests

Cover every case listed in Specification §14, especially:

- missing file, directory, symlink, absolute path, and traversal failures;
- zero, one, ambiguous, and replace-all matching;
- literal replacement-token text;
- LF, CRLF, mixed endings, tabs, trailing spaces, and final-newline state;
- BOM, multibyte UTF-8, invalid UTF-8, and the 64 MiB guard;
- artifact role preservation and capture-metadata clearing, plus
  completion-status clearing if that field exists on the target branch;
- the real pipeline's structured error behavior.

#### Complete when

Tests prove that only the requested exact substring and required manifest
metadata change. The tool exists and is exported but is not model-visible yet.

**Suggested commit:** `tools: add exact byte-preserving file edits`

### Step 3 — Reconcile the scratch workspace

#### Files

- `src/run/syncScratchWorkspace.ts`
- `src/run/syncScratchWorkspace.test.ts`
- `src/run/artifacts.ts` only if a missing narrow manifest operation is found

#### Work

1. Implement `syncScratchWorkspace(runDir)` as one post-command walk of
   `<runDir>/scratch/workspace`.
2. Do not take a pre-command filesystem snapshot. Compare current exact hashes
   with existing manifest entries under `scratch/workspace/`.
3. Never follow symlinks. Open with no-follow behavior where supported, then
   `fstat` the opened handle and require a regular file.
4. Reject symlinks, sockets, devices, FIFOs, and other special files loudly.
5. Before and during each read, enforce the fixed 256 MiB per-file limit.
6. Send every new or modified file's exact bytes through `writeArtifact()` at
   its existing scratch path.
7. For each tracked workspace entry absent from the walk, call
   `removeScratchArtifactEntry()`.
8. Return a path-sorted list of `{ path, change }` values for created,
   modified, and deleted files. Stable ordering keeps tests and transcripts
   deterministic.
9. Leave files outside `scratch/workspace/` untouched.

#### Tests

- New, same-size modified, unchanged, and deleted files are classified
  correctly.
- Nested directories work without a required internal taxonomy.
- Exact bytes and hashes are preserved.
- Symlinks and special files fail without being followed or manifested.
- A file over 256 MiB fails before allocation; a file growing during read also
  fails.
- Repeating a successful sync reports no changes.
- A sync failure does not claim unprocessed files in `changed_files`.

#### Complete when

One function can make the manifest truthful about every surviving regular file
inside the command workspace.

**Suggested commit:** `run: synchronize command workspace provenance`

### Step 4 — Implement bounded foreground commands

#### Files

- `src/tools/bash/runForegroundCommand.ts`
- `src/tools/bash/runForegroundCommand.test.ts`

#### Work

1. Give `runForegroundCommand()` only process-lifecycle inputs: shell path,
   command, cwd, environment, timeout, output byte limit, and abort signal.
2. Spawn fixed `/bin/bash -c <command>` without a login shell, with stdin
   closed and a fresh process group.
3. Capture stdout and stderr separately while enforcing a 10 MiB combined raw
   byte ceiling. Count bytes before decoding strings.
4. Converge exit, spawn error, timeout, abort, and output overflow on one
   settlement path.
5. On timeout, abort, or overflow, signal the entire process group with
   `SIGTERM`, wait two seconds, then use `SIGKILL` if needed.
6. When the shell exits, terminate remaining group members and drain inherited
   stdout/stderr pipes for no more than one second. Do not wait forever for a
   descendant-held `close` event.
7. Resolve exactly once with status, exit code, termination signal, duration,
   stdout, and stderr. Throw only for setup/spawn failures that have no command
   result.
8. Remove abort listeners, stream listeners, timers, and process handles on
   every path.
9. Keep browser, manifest, transcript, model, and checkpoint knowledge out of
   this file.

#### Tests

Use real short-lived child processes on POSIX plus injected clocks/timers where
helpful:

- stdout/stderr separation, zero and nonzero exit, and signal reporting;
- stdin EOF and absence of login/profile sourcing;
- already-aborted calls never spawn;
- timeout and cancellation kill child and descendant processes;
- a shell-created background descendant does not survive the invocation;
- 10 MiB combined output termination and multibyte byte counting;
- inherited-pipe drain deadline;
- no double settlement or leaked listeners/timers.

#### Complete when

The helper can safely bound one foreground process tree without knowing what a
Bash tool or browser is.

**Suggested commit:** `tools: add bounded foreground command execution`

### Step 5 — Expose the selected local page to generated scripts

#### Files

- `src/browser/controller.ts`
- `src/browser/playwrightBrowserController.ts`
- `src/browser/browserScriptHelper.mjs`
- `src/browser/playwrightBrowserController.test.ts`
- a focused helper integration test if keeping it separate is clearer

#### Work

1. Add `BrowserScriptSetup` plus the two optional methods directly to
   `BrowserController`:

   ```ts
   prepareForBrowserScript?(): Promise<BrowserScriptSetup>;
   refreshAfterBrowserScript?(): Promise<void>;
   ```

2. At browser-session startup, reject a controller that implements exactly one
   of the two methods.
3. Launch local Chrome with `--remote-debugging-port=0`. Read
   `DevToolsActivePort` from the exact profile directory, build the endpoint,
   and require a loopback host.
4. Pass that endpoint into `PlaywrightBrowserController`; other providers keep
   omitting both methods.
5. In `prepareForBrowserScript()`, create a CDP session for the selected page
   and call `Target.getTargetInfo` to obtain the public target ID. Do not use
   Playwright private fields.
6. Implement `browserScriptHelper.mjs` using the application's bundled
   Playwright import. `connectSelectedPage()` must:
   - validate all three environment variables;
   - reject non-loopback CDP URLs;
   - connect over CDP;
   - require exactly one page with the requested target ID;
   - return real Playwright objects without closing the owning browser;
   - never fall back to the first page.
7. In `refreshAfterBrowserScript()`, rescan `BrowserContext.pages()` and
   reconcile `activePage`. The judge-branch controller has no separate
   document/observation state store, so do not add one solely for this feature;
   the required follow-up `inspect_page` creates the fresh outline.
8. If the selected page closed, select a remaining live page or create a fresh
   task page. If the entire browser closed, fail and leave it closed.
9. Keep the existing screenshot/download behavior unchanged and make repeated
   prepare/refresh calls safe. If stable browser identity is later ported from
   Browser V2, its refresh path must also invalidate old refs and observation
   baselines.

#### Tests

- The provider exposes a loopback endpoint and a target ID for the selected
  fixture page.
- The helper connects to that exact page and never another tab.
- Locator click/fill/wait/extraction works through the secondary connection.
- `inspect_page` after navigation or DOM mutation returns a fresh outline;
  pre-script refs are never assumed valid.
- Popups and selected-page closure reconcile correctly.
- The secondary client disconnects without closing Chrome.
- Unsupported controllers omit both methods; one-method controllers fail
  startup validation.
- Refresh is idempotent and whole-browser closure fails loudly.

#### Complete when

A standalone `.mjs` script can attach to the controller's selected local page
without a browser lease or private Playwright API.

**Suggested commit:** `browser: expose selected page to local scripts`

### Step 6 — Implement the Bash tool

#### Files

- `src/tools/bash/bash.ts`
- `src/tools/bash/bash.test.ts`
- `src/tools/registry.ts`
- `src/tools/index.ts` only for exports; do not register the tool yet

#### Work

1. Define the strict model schema and `BashResult` exactly as specified. Use a
   default timeout of 30 seconds and reject values above 120 seconds.
2. Mark the tool `readOnly: false`. Do not add `run_in_background`.
3. Add optional `abortSignal` to `ToolCtx`.
4. In `bash.ts`, build a fresh child environment from `process.env`:
   - remove names in the shared run-level secret denylist;
   - remove `BASH_ENV` and `ENV`;
   - set the four noninteractive Git/pager variables;
   - add the three browser variables only after successful browser
     preparation for `uses_browser: true`.
5. Keep environment construction as a small function in `bash.ts`; do not add
   an environment-manager class or a new file unless the function becomes
   independently reused.
6. For `uses_browser: true`, require both lifecycle methods, call prepare, and
   resolve the bundled helper's absolute file URL. Unsupported controllers
   fail before spawn. `uses_browser: false` must not call either method.
7. Invoke `runForegroundCommand()` in `scratch/workspace`.
8. In cleanup, always attempt `syncScratchWorkspace()`. If browser preparation
   succeeded, always attempt browser refresh as well. Preserve the primary
   failure while reporting cleanup failures clearly.
9. Return `changed_files` from the sync result and let the existing tool
   pipeline serialize and apply its normal 50 KB `capResult` behavior.
10. Do not write command output files, receipts, checkpoints, or transcript
    entries inside the tool.

#### Tests

- Strict schema/defaults and timeout rejection.
- Exact cwd, environment allow/deny behavior, and no mutation of
  `process.env`.
- Nonzero exits are successful tool results; spawn/sync/refresh failures are
  execution errors.
- Existing `capResult` offload shape handles large Bash JSON.
- Workspace changes are synchronized after exit, timeout, cancellation,
  overflow, and spawn failure where applicable.
- `uses_browser: false` performs no browser lifecycle work.
- `uses_browser: true` injects exact helper/CDP/target values and refreshes in
  cleanup.
- A generated script changes the fixture page and writes a manifested JSON
  file.

#### Complete when

The Bash definition works through direct and pipeline tests but remains absent
from the model-visible production registry.

**Suggested commit:** `tools: add finite local bash execution`

### Step 7 — Add checkpoint storage

#### Files

- `src/run/runCheckpointStore.ts`
- `src/run/runCheckpointStore.test.ts`

#### Work

1. Define and validate versioned `RunCheckpointV1` in
   `runCheckpointStore.ts`. Keep the public store surface to `load`, `save`,
   and `close` plus `openRunCheckpointStore(runDir)`.
2. Persist the specification's agent-loop state, usage accounting, judge-cycle
   progress, pending turn, phase, and terminal result.
3. Also persist the scalar configuration required to resume the same run:
   resolved model name, tool profile, output/context limits, start URL, and
   serializable judge-harness policy. Do not persist functions, credentials,
   tracing clients, abort signals, or browser objects; callers supply those
   again.
4. Create `harness/` with mode `0700` and acquire `harness/run.lock` with
   exclusive `0600` creation before loading mutable state.
5. Implement live-owner rejection, dead-owner stale-lock recovery, corrupt-lock
   preservation, one retry, owner-checked release, and an ownership check
   before each save.
6. Serialize saves and require strictly increasing `checkpointRevision`.
7. Save through `checkpoint.json.tmp`, flush it, rename it atomically, then
   flush the `harness/` directory where supported.
8. Ignore a leftover temp file on load. Reject missing/invalid main checkpoint
   when resuming.
9. Make `close()` idempotent, wait for an active save, reject later saves, and
   release the lock last.

#### Tests

- First save/load and exact schema round-trip.
- Atomic replacement leaves the previous checkpoint readable on injected
  pre-rename failure.
- Concurrent saves serialize; stale or duplicate revisions fail.
- Live, stale, corrupt, and ownership-changed lock cases.
- Idempotent close, save-after-close failure, and pending-save flush.
- Temp-file recovery behavior and mode assertions on POSIX.
- Agent-loop token totals, turn count, peak context, and elapsed wall time
  round-trip exactly.

#### Complete when

One store durably owns a resumable run without knowing how tools execute.

**Suggested commit:** `run: add durable checkpoint storage`

### Step 8 — Checkpoint execution transitions and implement resume

#### Files

- `src/loop/scheduler.ts`
- `src/loop/scheduler.test.ts`
- `src/loop/agentLoop.ts`
- `src/loop/agentLoop.test.ts`
- `src/cli/runTask.ts`
- `src/cli/runTask.test.ts`
- `src/harness/harness.ts`
- `src/harness/harness.test.ts`

#### Work

1. Add narrow, awaited scheduler callbacks rather than a coordinator class:
   - before a state-changing call starts;
   - after any call produces its pipeline result.
2. Preserve the scheduler's existing batching, read concurrency, barriers, and
   request-order results. Unknown tools remain state-changing.
3. Let `runTask.ts` own the mutable checkpoint revision and run progress. Pass
   plain callbacks into `runAgentLoop()` and the scheduler; never put the
   checkpoint store in `ToolCtx`, and never pass it to a tool.
4. Make the existing in-memory `runAgentLoop()` state explicitly serializable:
   messages, turn count, token totals, peak context tokens, and elapsed wall
   time. Add a resume input for that state rather than introducing a
   `WorkerSession` class.
5. Keep the judge branch's existing cycle behavior: every judge correction
   starts a fresh agent-loop conversation whose opening message includes the
   feedback. Checkpoint the current cycle number, opening message, completed
   cycle records, and archived metrics; do not silently change it to the later
   persistent-session architecture.
6. Open the checkpoint store immediately after run-directory/manifest
   creation. Save an `initializing` checkpoint before the optional initializer
   call, persist its accepted output before writing `INTENT.md` and
   `CONTRACT.md`, then save `ready_for_model` after those files exist. Recovery
   can therefore finish the deterministic file writes without repeating an
   accepted initializer response.
7. After a complete model response is accepted, append it to worker memory,
   create `pendingTurn` with all calls `pending`, and save before executing any
   call.
8. Before each state-changing call, mark only that call `running` and await the
   save. After each result, mark it `finished`, store the pipeline result, and
   await another save.
9. Once the result batch has passed the existing combined-result cap and its
   exact user message is in worker memory, save `ready_for_model` and clear
   `pendingTurn`. This final turn save is the authoritative model-facing form;
   intermediate finished results exist to prevent replay.
10. After a worker cycle, checkpoint its result and archived metrics before
    entering `judging`. A crash during the read-only judge call may rerun that
    call, but it must not rerun the completed worker cycle. Save the verdict,
    next-cycle opening message, cycle record, or terminal outcome immediately
    after it is accepted.
11. Add `resumeTask(runDir, config)` beside `runTask`. Reuse the same private
    agent-loop and judge-cycle functions rather than copying orchestration.
12. Match current browser ownership: the caller supplies a newly created
    `BrowserController` in the resume config, and `resumeTask` owns only its
    fresh task tab. Do not add a second browser-session provider abstraction.
13. On resume:
    - acquire the lock before loading mutable state;
    - validate checkpoint version, scalar configuration, manifest structure,
      and manifest hashes;
    - for a `running` Bash call, require
      `confirmPreviousCommandStopped: true`, then synchronize the workspace
      before hash verification;
    - restore agent-loop accounting and judge-cycle progress;
    - reopen the start URL when configured;
    - append one browser-recreated notice to worker memory;
    - continue pending read-only calls;
    - never replay a `running` state-changing call;
    - append an interrupted error for that call and not-executed errors for
      later pending calls;
    - resume `judging` from the stored completed worker result without running
      that worker cycle again;
    - return an already stored terminal result without calling the model.
14. Change finalization order so resumable crashes do not masquerade as
    terminal runs. Save the terminal checkpoint before final metrics/manifest
    closure; make terminal cleanup idempotent so recovery after the terminal
    save can finish it safely.
15. Keep transcript events as audit output. Never reconstruct worker messages
    by replaying the transcript.

#### Tests

Use deterministic fault injection at every boundary named in Specification
§14:

- accepted response before the first tool;
- edit side effect before its finished checkpoint;
- Bash running, and Bash exited before its finished checkpoint;
- accepted initializer output before its files; completed worker cycle before
  judge; before and after a judge verdict; terminal before return;
- pending read-only calls resume, running state-changing calls do not replay;
- a running Bash checkpoint refuses resume without explicit stop
  confirmation;
- restored messages, usage totals, turn count, cycle number, judge feedback,
  archived metrics, and results are exact and monotonic;
- changed or missing manifest bytes fail recovery before model execution;
- stale browser refs are never reused and the worker receives the recovery
  notice;
- an already-terminal checkpoint makes no model or tool call.

#### Complete when

Killing and restarting the harness at any checkpoint boundary either continues
from durable state or stops with a precise recovery error; it never silently
replays an uncertain state-changing call.

**Suggested commit:** `run: checkpoint and resume worker execution`

### Step 9 — Activate the worker tools and cancellation path

#### Files

- `src/tools/index.ts`
- `src/cli/systemPrompt.ts`
- `src/cli/systemPrompt.test.ts`
- `src/cli/runTask.ts`
- `src/tui/bridge/runSession.ts`
- affected TUI/run-session tests
- `AGENTS.md`
- `docs/revised-browser-agent-implementation-plan.md`
- any other binding document that still claims the worker has no shell

#### Work

1. Validate `/bin/bash` is executable and create `scratch/workspace/` with
   mode `0700` before any initializer or worker model call.
2. Define one clearly named secret environment-variable denylist in
   `runTask.ts` and pass it into the Bash tool context/dependency. Cover model,
   tracing, credential-file, and other recognized application secrets.
3. Add optional `signal` to `RunTaskConfig`, pass it to `ToolCtx.abortSignal`,
   and have the TUI forward its existing run `AbortSignal`.
4. Register `editFileTool` immediately after `writeFileTool` in `fileTools`.
5. Register `bashTool` directly after `...fileTools` in the production worker
   registry, before browser tools. Do not create a `codeTools` group.
6. Keep initializer and judge model calls tool-less and add an explicit
   regression test proving neither contains `edit_file` or `bash`.
7. Update `SYSTEM_PROMPT` with the short workspace, edit, Bash,
   `uses_browser`, publish, and post-Bash `inspect_page` guidance from the
   specification. Keep it static.
8. Update deterministic tool-order and prompt-prefix tests for the one
   intentional prefix change.
9. Update binding documentation in the same commit:
   - replace the absolute no-Bash prohibition with the local finite worker-only
     contract;
   - document the explicit `scratch/workspace` reconciliation exception to the
     write chokepoint;
   - keep the initializer/judge prohibition and the no-security-boundary
     warning.
10. Ensure the `.mjs` helper is included in the installed package by the
    existing `files` rules; add a package-content test only if the current
    packaging checks do not cover it.

#### Tests

- Exact production tool order is `read_file`, `write_file`, `edit_file`,
  `grep`, `bash`, then the existing browser groups.
- Repeated `toApiToolDefs()` calls are byte-identical.
- TUI cancellation reaches an active Bash process group and checkpoint close
  waits for cleanup.
- Invalid shell/workspace/controller setup fails before the worker model call.
- Secret canaries do not appear in the child environment, transcript,
  checkpoint, manifest, or command output.
- Initializer and judge cannot invoke either mutation tool.

#### Complete when

The worker sees the two tools in a stable prompt, cancellation reaches Bash,
and every binding document describes the behavior that is actually enabled.

**Suggested commit:** `agent: enable durable local code execution`

### Step 10 — End-to-end verification and handoff

#### Work

1. Add one hermetic fixture test that drives the real production worker tool
   registry through this sequence:
   - `write_file` creates `scratch/workspace/collect.mjs`;
   - `edit_file` makes one exact change;
   - `bash` with `uses_browser: true` runs it;
   - the script uses Playwright locators and writes intermediate JSON;
   - workspace sync manifests the script and JSON;
   - `inspect_page` sees the changed page;
   - `write_file` publishes the requested output with its proper role.
2. Run the same scenario with a fault after Bash starts. Confirm resume refuses
   without stop confirmation, then continues without replay after the prior
   process tree is confirmed gone.
3. Review the implementation against every acceptance criterion in
   Specification §16 and record the test or code path proving each one.
4. Run focused tests first, then repository gates:

   ```bash
   npm run typecheck
   npm test
   git diff --check
   ```

5. Inspect the final production tool definitions, prompt bytes, package files,
   and `git status`. Do not include unrelated worktree changes.
6. Update the implementation handoff with completed commits, exact checks,
   remaining limitations, and the first useful follow-up measurement. Do not
   claim performance improvement until it is measured.

#### Complete when

- All Specification §16 acceptance criteria have direct test coverage.
- Typecheck and the full hermetic suite pass.
- The final diff contains no remote sandbox, background-process subsystem,
  generic execution runtime, browser lease, receipt store, or second output
  pipeline.
- No live eval was run unless the user separately requested it.

**Suggested commit:** `test: verify local code execution recovery`

## 5. Expected commit series

The intended review sequence is:

1. `run: add manifest reconciliation primitives`
2. `tools: add exact byte-preserving file edits`
3. `run: synchronize command workspace provenance`
4. `tools: add bounded foreground command execution`
5. `browser: expose selected page to local scripts`
6. `tools: add finite local bash execution`
7. `run: add durable checkpoint storage`
8. `run: checkpoint and resume worker execution`
9. `agent: enable durable local code execution`
10. `test: verify local code execution recovery`

Each commit should pass its focused tests. Steps 1–8 deliberately keep Bash
out of the production registry, so an intermediate checkout cannot advertise a
partially durable execution feature.

## 6. Deliberately deferred

- Remote or container sandboxes.
- Windows command and signal support.
- Background or detached commands.
- Attaching to an in-flight process after restart.
- Automatic orphan-process supervision after a hard parent kill.
- Per-run package installation or dependency environments.
- Static shell parsing or read-only command inference.
- A generic runtime, workspace manager, browser lease, capability object,
  receipt store, or Bash-specific output store.
- Live eval re-baselining and default-policy changes based on performance
  results.
