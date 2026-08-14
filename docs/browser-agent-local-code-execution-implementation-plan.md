# Browser Agent Local Code Execution — Step-by-Step Implementation Plan

**Status:** Proposed

**Date:** 2026-08-13

**Design source:** [Browser Agent Local Code Execution — Detailed Specification](./browser-agent-local-code-execution-spec.md)

**Implementation target:** `feat/judge-harness`, now fast-forwarded to
`feat/browser-agent-v2` at `658450e`, with Browser Agent V2 merged in as the
baseline.

This document was originally authored against a pre-V2 checkout (`cb2e22d`)
and claimed the later `WorkerSession`, `RunBudgetTracker`, output-contract, and
stable-observation work were not prerequisites. That is no longer true: the
branch has since been fast-forwarded past all of it, and this specification
and plan (commits `432ef0f` and `97bfb10`) have already been cherry-picked
onto the new baseline. Every step below is revised to build on the V2
architecture — one persistent worker conversation, a whole-run budget, a
typed output-contract store, a verifier (not a judge), and access-based
scheduling — rather than the pre-V2 fresh-loop-per-cycle model. See Step 0 for
exactly what was confirmed and how.

## Decisions

These were settled by the user before implementation and apply across every
step below.

| # | Decision | Rationale |
| - | -------- | --------- |
| 1 | Register `edit_file` and `bash` in BOTH current worker registries — legacy `createProductionRegistry` (via `fileTools`) and `V2_TOOL_ORDER`. | The legacy registry is still the production default (`DEFAULT_TOOL_PROFILE = 'atomic'`); registering the tools only in `V2_TOOL_ORDER` would leave them unavailable in normal REPL/TUI runs. |
| 2 | Files group order in both registries: `read_file, write_file, edit_file, grep, bash`. | Keeps the new tools adjacent to the file tools they extend, in both registries, with one stable rule instead of two different insertion points. |
| 3 | Do not default-enable `harness.outputContract`. | The V2 cutover (atomic → contract-first) is a separate decision from this feature; this plan must not change the default architecture as a side effect. |
| 4 | Initializer and verifier tool surfaces are unchanged. Neither ever receives `bash` or `edit_file`. | The initializer keeps its sole forced `set_output_contract`; the verifier keeps read-only `read_file`/`grep`. Widening either surface is out of scope for local code execution. |
| 5 | Both prompt prefixes (legacy and V2) change exactly once, intentionally. | `SYSTEM_PROMPT` and `toApiToolDefs` must stay byte-stable except for this one deliberate change; prior eval baselines are not byte-comparable afterward, and that cost is accepted up front rather than discovered later. |
| 6 | Testing cadence: implement all steps without running tests after each one, then run targeted suites plus `npm run typecheck` once at the end (Step 10). | Overrides this plan's original rule 9 ("make each step a focused, reviewable commit after its tests pass"). One focused commit per step is kept, but per-step test execution is deferred so the whole feature is verified in one pass instead of ten. |

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
5. Keep Bash and file mutation out of initializer and VERIFIER model calls.
6. Keep tool registration and `SYSTEM_PROMPT` deterministic. Do not vary the
   tool list by task, workspace contents, or browser capability.
7. Do not add a remote sandbox, background commands, package installation,
   Windows support, receipts, or a Bash-specific output store.
8. Use fixed bounds from the specification; do not silently clamp invalid
   inputs.
9. Implement all steps without running tests after each one; run targeted
   suites plus `npm run typecheck` once, at Step 10 (Decision 6). Keep one
   focused, reviewable commit per step regardless — stage only the files
   belonging to that step, and let Step 10 be the single point where every
   step's tests are actually executed.
10. Do not run a live eval re-baseline without separate user direction.
11. Both `edit_file` and `bash` must declare `getAccess`, not rely on
    `readOnly`. `readOnly` is compatibility-only in the V2 scheduler
    (`src/tools/registry.ts:150-157`); a state-changing tool that only sets
    `readOnly: false` gets the coarse legacy exclusivity treatment instead of
    a precise `ToolAccess` declaration, which is the actual conflict
    boundary the access-based scheduler (`src/tools/registry.ts:66-103`)
    uses to decide what may run concurrently.
12. A contract-bound deliverable may be written only by the tool that owns
    it. `edit_file` and `write_file` must not become a side door around
    `upsert_output_rows` / `write_document` for a filename the active output
    contract declares — see Step 2.

Keep the new tools out of the production registry until Step 9. This lets the
implementation land in small tested pieces while changing the prompt prefix
only once, when both tool contracts and their recovery behavior are ready.

## 3. Implementation order

The table's shape is unchanged from the original plan. Step 0 is listed for
completeness and dependency tracking only — it is already done (see Step 0
below for what was confirmed and when).

| Step | Deliverable                                                            | Depends on |
| ---- | ---------------------------------------------------------------------- | ---------- |
| 0    | Confirm the branch baseline and existing tests (COMPLETED)             | —          |
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

### Step 0 — Confirm the baseline (COMPLETED)

This step is done. It is kept as a record of what was actually confirmed,
since every later step in this plan depends on the baseline described here
rather than the pre-V2 baseline the plan originally assumed.

#### What happened

1. The branch was fast-forwarded from `cb2e22d` to `feat/browser-agent-v2` at
   `658450e` with `git merge --ff-only`. Git accepted the fast-forward because
   `cb2e22d` was a strict ancestor of `658450e`; zero commits were lost or
   rewritten, and the worktree needed no conflict resolution.
2. The two planning documents (this plan and its spec) were cherry-picked onto
   the new baseline as `432ef0f` (spec) and `97bfb10` (plan), on top of
   `658450e`.
3. Node is v22.17.0 in the implementation worktree.
4. The baseline suites over the seams this feature touches were run against
   the new checkout, using the V2 file paths that actually exist (the old
   command list named files that no longer exist or have been renamed —
   `src/harness/judge.test.ts` is gone, replaced by `src/harness/verifier.test.ts`,
   and `src/loop/workerSession.test.ts` / `src/run/runBudget.test.ts` are new):

   ```bash
   npm test -- src/run src/tools/pipeline.test.ts src/tools/index.test.ts \
     src/loop src/contracts src/harness src/cli/runTask*.test.ts
   npm run typecheck
   ```

   These pass at **280 tests across 22 files**.
5. One failure surfaced on the first run: a stale `node_modules` in this
   worktree, predating V2's addition of `csv-stringify` and related
   dependencies. `npm install` resolved it. No test was weakened or skipped to
   get to green; the fix was purely a dependency-installation gap in the
   worktree, not a code or test defect.

#### Complete when

- The starting state (baseline commit, doc provenance, dependency state, test
  count) is known and recorded here. — Done.
- No production files were changed to reach this baseline. — Confirmed; only
  `npm install` touched `node_modules`, and the two doc commits are
  documentation.

There is no implementation commit for this step beyond the doc cherry-picks
already listed above.

### Step 1 — Add the required manifest operations

#### Files

- `src/run/artifacts.ts`
- `src/run/artifacts.test.ts`

#### Work

1. Export a production `readManifest(runDir)` function by promoting the
   existing private manifest reader (`loadManifest`, `src/run/artifacts.ts:210`).
   It must still fail loudly on a missing or invalid manifest. Note, as a
   consolidation opportunity explicitly OUT OF SCOPE for this step: at least
   three call sites already read `manifest.json` ad hoc instead of going
   through `loadManifest` — `src/tui/bridge/tuiTracing.ts:56`,
   `src/tui/runScanner.ts:32`, and `src/completion/finalizeIncompleteRun.ts:122`
   (and `src/completion/completionCheck.ts:188`, which parses it directly
   inside `validateManifestIntegrity`). Promoting `loadManifest` to
   `readManifest` does not migrate any of them; that cleanup is deferred (see
   §6).
2. Add `removeScratchArtifactEntry(runDir, relPath)`:
   - normalize through `resolveRunPath()`;
   - accept only a path under `scratch/`;
   - remove only the manifest entry, because the caller has already observed
     that the file is absent;
   - fail when asked to remove an `artifacts/` entry;
   - make a missing scratch entry a no-op so one reconciliation pass can be
     idempotent.
3. Add `verifyManifestFiles(runDir)` for recovery. The obvious move is to
   delegate to `validateManifestIntegrity`
   (`src/completion/completionCheck.ts:178-230`), which already walks every
   entry, resolves it through `resolveRunPath()`, and compares its recorded
   SHA-256 against the file's bytes. **That delegation was attempted during
   implementation and rejected for two reasons — do not re-attempt it without
   addressing both:**

   - **It closes an import cycle.** `completionCheck.ts` already imports
     `ARTIFACTS_DIR`, `writeArtifact`, and the manifest types *from*
     `artifacts.ts`. A wrapper living in `artifacts.ts` that calls back into
     `completionCheck.ts` completes the loop. Hoisting the shared checker into
     a third module would break the cycle, but that is a wider refactor than
     this step should carry.
   - **It follows symlinks.** `validateManifestIntegrity` reads through
     `existsSync`/`readFileSync`, so it cannot make the guarantee recovery
     needs: that the bytes hashed came from a *regular, non-symlink* file and
     not through a link planted where a manifest entry used to be. That is a
     different read discipline, not a missing flag.

   So `verifyManifestFiles` is implemented directly in `artifacts.ts`: open
   each entry with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` the opened
   handle and require `isFile()`, hash the bytes read from that handle, and
   collect **every** problem — escaping path, missing file, symlink, non-regular
   file, hash mismatch — into one thrown error rather than failing on the first.
   The code comment must carry this rationale, so the apparent duplication
   reads as a decision rather than an oversight.

   The residual duplication is real and deliberate: hash verification now
   exists in two places with different read disciplines. Consolidating them
   behind one shared no-follow reader is deferred (see §6).
4. Keep manifest serialization in `artifacts.ts`; do not create another
   manifest repository or storage class.

#### Tests

- Reading returns the existing manifest shape without mutating it.
- Scratch-entry removal preserves every unrelated entry.
- Removing an artifact entry or an escaping path fails.
- Repeating a scratch removal is harmless.
- `validateManifestIntegrity` now also detects symlinked and other
  non-regular recorded files, in addition to its existing missing-file and
  hash-mismatch cases; existing completion-check tests for it keep passing
  unchanged.
- `verifyManifestFiles` returns normally when `validateManifestIntegrity`
  reports no failures, and throws one error naming every failure otherwise
  (missing file, symlink, hash mismatch, each represented).
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

2. Mark the tool `readOnly: false` and declare `getAccess(input)` returning
   `{ writes: [accessKey.file(input.file_path), accessKey.manifest()] }`
   (`accessKey` from `src/tools/registry.ts:86-99`). This is the precise
   conflict declaration the access-based scheduler needs (Rule 11); do not
   rely on `readOnly` alone to make the tool a barrier.
3. In `execute`, resolve and revalidate the path at execution time. Require an
   existing regular non-symlink file under `artifacts/` or `scratch/`.
4. Before touching the filesystem, resolve the CURRENT output contract via
   `ctx.outputContracts?.currentContract()` — called fresh on every
   invocation, never cached on the tool or read once at startup, since the
   worker can revise the contract mid-run (`set_output_contract` is
   available to the worker, not just the initializer). If the contract is
   defined and any `table` or `document` output's `filename` matches the
   normalized target path's basename, refuse the edit with a message
   directing the model to `upsert_output_rows` (for `table` outputs) or
   `write_document` (for `document` outputs) instead. This closes off
   `edit_file` becoming a fresh way to bypass the completion checks that
   only run against contract-owned writers — those checks validate a
   contract-bound deliverable's shape (columns, rows, sections) at the
   point it is written, and an unconstrained `edit_file` on the same
   filename would let the model rewrite it byte-for-byte outside that path.
   Note that `write_file` has the identical hole today — it can also
   overwrite a contract-owned filename directly — and closing it is
   explicitly OUT OF SCOPE for this step; only `edit_file`, the tool this
   step adds, gets the refusal.
5. Reject a file larger than 64 MiB before allocating its contents.
6. Read bytes, decode as UTF-8, and prove byte stability by re-encoding before
   editing. Preserve a UTF-8 BOM; reject invalid or unsupported encodings.
7. Reject an empty `old_string` and `old_string === new_string`.
8. Count exact non-overlapping matches without newline, whitespace, quote,
   Unicode, or indentation normalization.
9. Fail on zero matches. With `replace_all` omitted or false, fail unless the
   count is exactly one. With `replace_all: true`, replace all matches.
10. Use literal replacement semantics so `$&`, `$1`, and similar text in
    `new_string` stays literal.
11. Keep the final read, validation, replacement, and `writeArtifact()` call in
    one synchronous critical section.
12. For a scratch file, write without roles. For a published artifact, require
    its existing manifest entry, preserve `roles`, and omit the old
    `sourceUrl`. `completionStatus` clearing is UNCONDITIONAL: the field
    exists on the V2 baseline (`ManifestEntry.completionStatus?: 'complete'|'partial'`),
    so always omit it on the rewritten entry rather than hedging on whether
    it has landed yet.
13. Return only the normalized `file_path` and `replacement_count`.

#### Tests

Cover every case listed in Specification §14, especially:

- missing file, directory, symlink, absolute path, and traversal failures;
- zero, one, ambiguous, and replace-all matching;
- literal replacement-token text;
- LF, CRLF, mixed endings, tabs, trailing spaces, and final-newline state;
- BOM, multibyte UTF-8, invalid UTF-8, and the 64 MiB guard;
- artifact role preservation and unconditional capture-metadata and
  completion-status clearing;
- refusal when the target path's basename matches a `table` or `document`
  output's `filename` in the current contract, for both kinds, with a
  message naming the correct replacement tool; no refusal when no contract
  is set, when the contract has no matching filename, or after the
  contract has been revised to drop that filename;
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

0. `scratch/workspace/` does not exist on the V2 baseline — the existing
   scratch subdirectories are `tool-output/`, `evidence/`, `output-contract/`,
   `documents/`, and `research-jobs/`. This feature is what creates
   `scratch/workspace/`, with mode `0700` (see Step 9, which creates it
   before any initializer or worker model call). `syncScratchWorkspace` must
   tolerate the directory being absent on its first call (nothing to
   reconcile yet) rather than assuming Step 9's creation has already run.
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

**ALREADY IN PROGRESS**, in a separate work stream: `src/tools/bash/runForegroundCommand.ts`
and `src/tools/bash/runForegroundCommand.test.ts` already exist (untracked) in
the implementation worktree. This section is unchanged in substance from the
original plan and remains the spec for that work; verify the in-progress
files against it rather than starting over.

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
   and require a loopback host. Today, `launchPersistentChrome`
   (`src/browser/playwrightBrowserController.ts:186-198`) calls
   `chromium.launchPersistentContext()` with NO `args` array at all — this is
   the first time this codebase passes Chrome any launch arguments, and
   correspondingly the first CDP usage anywhere in the repo. Treat both as
   new surface area to test carefully, not as extending an existing pattern.
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
7. In `refreshAfterBrowserScript()`, rescan `BrowserContext.pages()`, reconcile
   `activePage`, and INVALIDATE observation state for the affected page(s).
   This is required, not optional: a generated script can mutate the DOM
   in place, without any navigation, and in-place mutation does not by
   itself invalidate anything today — stamped `data-sherlock-el` refs and
   `BrowserStateStore`'s cached observations/baselines
   (`src/browser/browserState.ts:241-308`) stay silently "valid" against a
   page that has since changed underneath them. Call
   `BrowserStateStore.forgetPage(pageId)` for the selected page (and any
   other page the script touched, if that is observable) as part of the
   refresh, so a stale cached observation can never be served after a
   script runs. The required follow-up call to mint fresh refs is `observe()`
   under the V2 tool surface, or `inspect_page` on the legacy/atomic path —
   pick whichever the active registry exposes; do not assume `inspect_page`
   is the only option now that `observe()` exists.
8. If the selected page closed, select a remaining live page or create a
   fresh task page. FLAG THIS AS A DELIBERATE BEHAVIOR CHANGE, confined to
   the refresh path only: today, a closed selected page leaves `activePage`
   undefined with NO fallback (`src/browser/playwrightBrowserController.ts:910-925`).
   This step introduces the first fallback-selection behavior in the
   controller, and it must not be generalized to every code path that can
   observe a closed page — only `refreshAfterBrowserScript()` gets it, because
   only there do we know a local script just ran and may have closed the tab
   itself. If the entire browser closed, fail and leave it closed.
9. Keep the existing screenshot/download behavior unchanged and make repeated
   prepare/refresh calls safe.

#### Tests

- The provider exposes a loopback endpoint and a target ID for the selected
  fixture page.
- The helper connects to that exact page and never another tab.
- Locator click/fill/wait/extraction works through the secondary connection.
- After a script mutates the DOM without navigating, `refreshAfterBrowserScript()`
  invalidates the affected page's cached observations (`forgetPage` was
  called), and the subsequent `observe()`/`inspect_page` call returns a fresh
  outline rather than a stale cached one; pre-script refs are never assumed
  valid.
- Popups and selected-page closure reconcile correctly, including the new
  fallback-to-remaining-page / fresh-task-page behavior, exercised only
  through the refresh path (not asserted anywhere else in the controller).
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
2. Mark the tool `readOnly: false` and declare `getAccess()` returning
   `{ reads: [], writes: [], exclusive: true }` (Rule 11). A shell command can
   touch the filesystem, the browser, and process state in ways no access-key
   enumeration could soundly bound, so `exclusive: true` is the correct
   declaration — it is an explicit flag rather than a sentinel key
   specifically so it cannot be silently defeated by another call's access
   set (`src/tools/registry.ts:103-131`, `EXCLUSIVE_ACCESS` fail-closed).
3. Set an explicit `timeoutMs` on the `bash` `ToolDef`, comfortably above the
   model-supplied command timeout's own ceiling. The pipeline's
   `DEFAULT_TOOL_TIMEOUT_MS` is 120 seconds (`src/tools/pipeline.ts:45`), and
   `withToolDeadline` does not cancel a slow tool at that deadline — it
   ABANDONS it (`src/tools/pipeline.ts:218-235`), meaning the pipeline moves
   on while `bash`'s own child process group is potentially still alive and
   holding resources (including, for `uses_browser: true`, the CDP
   connection). Bash's own worst case is: up to 120 s command timeout, plus a
   2 s SIGTERM grace before SIGKILL, plus workspace-sync and browser-refresh
   time in cleanup. `timeoutMs` on the `ToolDef` must clear all of that with
   headroom, or the pipeline's deadline can fire first and abandon a bash
   call that was still correctly winding down. Do not use `Infinity`; bash's
   waiting is bounded by construction, so an explicit generous ceiling (not
   an opt-out) is the correct declaration.
4. Add optional `abortSignal` to `ToolCtx`. Note this is the FIRST
   tool-level cancellation seam in the codebase — `ToolCtx`
   (`src/tools/registry.ts:29-50`) and `RunTaskConfig`
   (`src/cli/runTask.ts:191-246`) have no such field today, and the only
   existing cancellation is the TUI wrapping `config.callModel`
   (`src/tui/bridge/runSession.ts:112-184`), which cancels model calls, not
   tool execution. Adding `abortSignal` here is new surface, not an
   extension of an existing pattern; wire it through deliberately rather than
   assuming other tools already had a place to plug into.
5. In `bash.ts`, build a fresh child environment from `process.env`:
   - remove names in the shared run-level secret denylist;
   - remove `BASH_ENV` and `ENV`;
   - set the four noninteractive Git/pager variables;
   - add the three browser variables only after successful browser
     preparation for `uses_browser: true`.
6. Keep environment construction as a small function in `bash.ts`; do not add
   an environment-manager class or a new file unless the function becomes
   independently reused.
7. For `uses_browser: true`, require both lifecycle methods, call prepare, and
   resolve the bundled helper's absolute file URL. Unsupported controllers
   fail before spawn. `uses_browser: false` must not call either method.
8. Invoke `runForegroundCommand()` in `scratch/workspace`.
9. In cleanup, always attempt `syncScratchWorkspace()`. If browser preparation
   succeeded, always attempt browser refresh as well. Preserve the primary
   failure while reporting cleanup failures clearly.
10. Return `changed_files` from the sync result and let the existing tool
    pipeline serialize and apply its normal 50 KB `capResult` behavior.
11. Do not write command output files, receipts, checkpoints, or transcript
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
- `getAccess()` reports `exclusive: true` and the tool's own `timeoutMs`
  clears the worst-case command timeout, SIGTERM grace, and cleanup time with
  headroom — a slow-but-legitimate run does not trip the pipeline's
  `DEFAULT_TOOL_TIMEOUT_MS` deadline and get abandoned mid-cleanup.

#### Complete when

The Bash definition works through direct and pipeline tests but remains absent
from the model-visible production registry.

**Suggested commit:** `tools: add finite local bash execution`

### Step 7 — Add checkpoint storage

#### Files

- `src/run/runCheckpointStore.ts`
- `src/run/runCheckpointStore.test.ts`

#### Work

The persisted state described here is V2's, not the pre-V2 model the
specification originally assumed. There is one persistent worker conversation
per run (`createWorkerSession`, called once), one whole-run budget tracker
shared across initializer/worker/verifier, one typed output-contract store
with an append-only revision history, and a verifier (not a judge) with its
own cycle count. Checkpointing must reflect that shape, not a fresh
agent-loop-per-cycle model.

1. Define and validate versioned `RunCheckpointV1` in
   `runCheckpointStore.ts`. Keep the public store surface to `load`, `save`,
   and `close` plus `openRunCheckpointStore(runDir)`.
2. Persist:
   - the single persistent worker session's serializable fields —
     `state.messages`, `state.turnCount`, `peakContextTokens`,
     `protocolCorrections`, `startedMs` (everything else on `WorkerSession`
     is a live handle in `deps`/`config`, not serializable state);
   - the whole-run `RunBudgetTracker`'s counters — `roles` (per-role usage),
     `toolCalls`, `toolResultBytes`, `corrections` — plus its `startedAt`,
     so a resumed run cannot refill headroom it already spent;
   - the current output-contract revision pointer (which revision in the
     store's append-only history is active), not contract content — the
     durable record of contract history is already the
     `scratch/output-contract/revision-<n>.json` files `writeArtifact`
     produces on every revision, and recovery should point at one of those
     rather than duplicating their content into the checkpoint;
   - the verifier cycle index and `completionCheckFailures` (the
     non-exhausting-failure counter that decrements `cycle` on a retry,
     `src/cli/runTask.ts:643,715`);
   - pending turn, phase, and the terminal `RunOutcome`
     (`src/run/runOutcome.ts`) when the run has ended. Use `runStatus:
     'verifying'` for the in-progress verification phase, not `'judging'` —
     the harness runs a verifier, not a judge, and the checkpoint's own
     vocabulary should match (`src/harness/judge.ts` no longer exists;
     `runVerifier`, `src/harness/verifier.ts:203`, is what the checkpoint is
     tracking progress against).
3. Also persist the scalar configuration required to resume the same run:
   resolved model name, tool profile, output/context limits, start URL, and
   serializable verifier-harness policy. Do not persist functions,
   credentials, tracing clients, abort signals, or browser objects; callers
   supply those again.
4. Budget ceilings are routinely `Infinity` in this codebase — every ceiling
   except `maxWorkerTurns` and `maxVerifierCorrections` defaults to
   `Infinity` at construction (`src/cli/runTask.ts:490-500`) — and
   `JSON.stringify` turns `Infinity` into `null`, silently losing the "no
   limit" meaning on round-trip. The specification already carries an
   `'unbounded'` string sentinel for `maxTurns` for exactly this reason
   (`maxTurns: number | "unbounded"`); extend that same treatment to every
   other persisted ceiling that can be `Infinity` — `maxToolCalls`,
   `maxModelTokens`, `maxToolResultBytes`, `maxWallTimeMs`, and
   `maxVerifierCorrections` all need the same `number | 'unbounded'`
   encoding, or a resumed run silently believes an unbounded ceiling was
   zero (or fails Zod validation on `null`) instead of unbounded.
5. Create `harness/` with mode `0700` and acquire `harness/run.lock` with
   exclusive `0600` creation before loading mutable state. Note this `harness/`
   directory is new and sits BESIDE the existing root-level `harness.json`
   FILE (`src/harness/harness.ts:20`, `HARNESS_FILENAME = 'harness.json'`) —
   a run-dir-root diagnostics file written once at the end of a harness-mode
   run's cycle loop. The two are unrelated and must not collide: `harness.json`
   is a flat file at the run-dir root; `harness/` is a new directory holding
   the lock and checkpoint. Confirm the run-dir layout tooling (anything that
   walks run-dir entries, e.g. artifact/manifest scanners) does not choke on
   a directory appearing next to a same-stem file.
6. Implement live-owner rejection, dead-owner stale-lock recovery, corrupt-lock
   preservation, one retry, owner-checked release, and an ownership check
   before each save.
7. Serialize saves and require strictly increasing `checkpointRevision`.
8. Save through `checkpoint.json.tmp`, flush it, rename it atomically, then
   flush the `harness/` directory where supported.
9. Ignore a leftover temp file on load. Reject missing/invalid main checkpoint
   when resuming.
10. Make `close()` idempotent, wait for an active save, reject later saves, and
    release the lock last.

#### Tests

- First save/load and exact schema round-trip.
- Atomic replacement leaves the previous checkpoint readable on injected
  pre-rename failure.
- Concurrent saves serialize; stale or duplicate revisions fail.
- Live, stale, corrupt, and ownership-changed lock cases.
- Idempotent close, save-after-close failure, and pending-save flush.
- Temp-file recovery behavior and mode assertions on POSIX.
- Worker-session token totals, turn count, peak context, elapsed wall time,
  and the whole-run budget's counters round-trip exactly.
- Every `Infinity`-valued ceiling round-trips through `'unbounded'`, not
  `null`; a finite ceiling round-trips as its exact number.
- `harness/run.lock` and `harness/checkpoint.json` coexist on disk with the
  existing root-level `harness.json` file without either write path
  interfering with the other.

#### Complete when

One store durably owns a resumable run without knowing how tools execute.

**Suggested commit:** `run: add durable checkpoint storage`

### Step 8 — Checkpoint execution transitions and implement resume

#### Files

- `src/loop/scheduler.ts`
- `src/loop/scheduler.test.ts`
- `src/loop/workerSession.ts` — the actual serializable-session target under
  V2 (see below); `agentLoop.ts` survives only as a compatibility wrapper
  around it and needs no new serialization logic of its own
- `src/loop/workerSession.test.ts`
- `src/run/runBudget.ts`
- `src/run/runBudget.test.ts`
- `src/contracts/outputContractStore.ts` — needs a new rehydration path (see
  below); it has none today
- `src/contracts/outputContractStore.test.ts`
- `src/cli/runTask.ts`
- `src/cli/runTask.test.ts`
- `src/harness/harness.ts`
- `src/harness/harness.test.ts`

#### Work

1. Add narrow, awaited scheduler callbacks rather than a coordinator class, at
   the precise seam already available inside the group closure at
   `src/loop/scheduler.ts:143-158` — after `slots.acquire()` and around
   `executeToolCall`:
   - before a state-changing call starts;
   - after any call produces its pipeline result.
2. Preserve the scheduler's existing batching, read concurrency, barriers, and
   request-order results. Unknown tools remain state-changing. This is now
   the access-based scheduler (`ToolDef.getAccess`, `accessesConflict`,
   `EXCLUSIVE_ACCESS`, `src/tools/registry.ts:66-131`), not the pre-V2
   read-only/state-changing split — the checkpoint callbacks must fire
   correctly under access-key conflict grouping, including for `edit_file`'s
   and `bash`'s own `getAccess` declarations from Steps 2 and 6.
3. Let `runTask.ts` own the mutable checkpoint revision and run progress. Pass
   plain callbacks into the worker-turn execution path and the scheduler;
   never put the checkpoint store in `ToolCtx`, and never pass it to a tool.
4. Restore the ONE persistent worker conversation on resume — not a fresh
   agent-loop conversation per cycle, which is how the pre-V2 architecture
   this plan originally targeted worked, and is now GONE. This largely
   reuses existing serialization seams rather than adding new ones:
   `captureWorkerSessionSnapshot(session)` and `restoreWorkerSession(snapshot,
   deps, config)` already exist in `src/loop/workerSession.ts` (around
   lines 335–411), and already capture/restore exactly the serializable
   fields named in this plan's facts — `state.messages`, `state.turnCount`,
   `peakContextTokens`, `protocolCorrections`, `startedMs`. **This plan
   originally assumed these seams did not exist and had to be added; they do
   exist already, pre-built for this purpose.** Step 8's job for the worker
   session is therefore to WIRE the checkpoint store to call
   `captureWorkerSessionSnapshot` on save and `restoreWorkerSession` on
   resume, not to design a new snapshot/restore pair. Verify their existing
   test coverage in `src/loop/workerSession.test.ts` before assuming any gap.
5. Restore the WHOLE-RUN budget on resume, so a restart cannot refill
   headroom the original run already spent. Likewise, this mostly reuses an
   existing seam: `createRunBudgetTracker(config, { restore })` already
   accepts a `RunBudgetSnapshot` (`src/run/runBudget.ts:174-220`), computing
   `startedAt` so elapsed wall time keeps counting through the restart, and
   `captureRunBudgetSnapshot(tracker)` already produces that snapshot. **As
   with the worker session, this plan originally assumed this factory did
   not exist and had to be added; it already does.** Step 8's job is to
   checkpoint the captured `RunBudgetSnapshot` and pass it back through
   `opts.restore` on resume — not to build a new restore-capable tracker.
6. The output-contract store has NO equivalent seam today —
   `createOutputContractStore(runDir)` always starts `history` empty in
   memory (`src/contracts/outputContractStore.ts:66-89`); there is no
   function that reads `scratch/output-contract/revision-<n>.json` files
   back into a store. This genuinely needs new code: add a rehydration path
   (for example `restoreOutputContractStore(runDir, revisions)` or a
   re-derivation that re-validates each persisted revision file in order and
   rebuilds `history`) so that resuming a run using the typed contract path
   does not lose its contract history. Checkpoint the current revision
   number so recovery knows how many revision files it expects to find.
7. Whether the initializer writes `INTENT.md`/`CONTRACT.md` at all now
   DEPENDS ON `config.harness.outputContract`, which Decision 3 keeps
   `false` by default:
   - **`outputContract: false` (the default; unchanged by this plan):** the
     initializer still writes prose `INTENT.md`/`CONTRACT.md` exactly as
     before. Open the checkpoint store immediately after
     run-directory/manifest creation. Save an `initializing` checkpoint
     before the optional initializer call, persist its accepted output
     before writing `INTENT.md` and `CONTRACT.md`, then save
     `ready_for_model` after those files exist. Recovery can therefore
     finish the deterministic file writes without repeating an accepted
     initializer response.
   - **`outputContract: true` (opt-in, not default):** no `INTENT.md`/
     `CONTRACT.md` are written at all; the contract lives in the typed
     output-contract store instead, with `scratch/output-contract/
     revision-<n>.json` as its durable form (Step 6's item 3, above). Save
     `ready_for_model` once the contract store is ready rather than waiting
     on any file write. Recovery rehydrates the contract store instead of
     replaying file writes.

   The plan's original "no `INTENT.md`/`CONTRACT.md` under V2" framing is
   only true for this second, opt-in branch — see the note at the end of
   this step's Work section.
8. After a complete model response is accepted, append it to worker memory,
   create `pendingTurn` with all calls `pending`, and save before executing any
   call.
9. Before each state-changing call, mark only that call `running` and await the
   save. After each result, mark it `finished`, store the pipeline result, and
   await another save.
10. Once the result batch has passed the existing combined-result cap and its
    exact user message is in worker memory, save `ready_for_model` and clear
    `pendingTurn`. This final turn save is the authoritative model-facing form;
    intermediate finished results exist to prevent replay.
11. After a worker cycle, checkpoint its result and archived metrics before
    entering `verifying` (V2's phase name for this state — the harness runs
    a verifier, `runVerifier`/`src/harness/verifier.ts:203`, not a judge;
    `src/harness/judge.ts` no longer exists). A crash during the read-only
    verifier call may rerun that call, but it must not rerun the completed
    worker cycle. Save the verdict, next-cycle opening message, cycle
    record, or terminal `RunOutcome` immediately after it is accepted. Also
    checkpoint `completionCheckFailures` (the counter that does `cycle -= 1`
    on a non-exhausting completion-check failure rather than spending a
    verifier attempt, `src/cli/runTask.ts:643,715`) and the verifier cycle
    index itself, so a resumed run does not silently grant back either a
    completion-check retry or a full verifier cycle it had already spent.
12. Add `resumeTask(runDir, config)` beside `runTask`. Reuse the same private
    worker-cycle and verification-harness functions (`runWorkerCycle`,
    `runVerificationHarness`) rather than copying orchestration.
13. Match current browser ownership: the caller supplies a newly created
    `BrowserController` in the resume config, and `resumeTask` owns only its
    fresh task tab. Do not add a second browser-session provider abstraction.
14. On resume:
    - acquire the lock before loading mutable state;
    - validate checkpoint version, scalar configuration, manifest structure,
      and manifest hashes;
    - for a `running` Bash call, require
      `confirmPreviousCommandStopped: true`, then synchronize the workspace
      before hash verification;
    - restore the worker session via `restoreWorkerSession` and the
      whole-run budget via `createRunBudgetTracker({ ..., restore })`, plus
      `completionCheckFailures` and the verifier cycle index;
    - rehydrate the output-contract store (item 6, above) when
      `outputContract: true`; when `outputContract: false`, confirm
      `INTENT.md`/`CONTRACT.md` already exist on disk rather than
      re-deriving anything;
    - reopen the start URL when configured;
    - append one browser-recreated notice to worker memory;
    - continue pending read-only calls;
    - never replay a `running` state-changing call;
    - append an interrupted error for that call and not-executed errors for
      later pending calls;
    - resume `verifying` from the stored completed worker result without
      running that worker cycle again;
    - return an already stored terminal result without calling the model.
15. Change finalization order so resumable crashes do not masquerade as
    terminal runs. Save the terminal checkpoint before final metrics/manifest
    closure; make terminal cleanup idempotent so recovery after the terminal
    save can finish it safely.
16. Keep transcript events as audit output. Never reconstruct worker messages
    by replaying the transcript.

Note on item 7: this plan's header and facts describe V2 as having "no
`INTENT.md`/`CONTRACT.md`." That is accurate only for the `outputContract:
true` branch. Decision 3 keeps `outputContract: false` the default, and on
that default path `config.harness` present still means the initializer
writes prose `INTENT.md`/`CONTRACT.md` exactly as the pre-V2 design did
(`src/cli/runTask.ts:239-242`). Do not build Step 8's checkpoint/recovery
logic as if those files never exist under V2 — they exist whenever
`outputContract` is left at its default.

#### Tests

Use deterministic fault injection at every boundary named in Specification
§14:

- accepted response before the first tool;
- edit side effect before its finished checkpoint;
- Bash running, and Bash exited before its finished checkpoint;
- accepted initializer output before its files (`outputContract: false`) or
  before the contract store is ready (`outputContract: true`); completed
  worker cycle before verification; before and after a verifier verdict;
  terminal before return;
- pending read-only calls resume, running state-changing calls do not replay;
- a running Bash checkpoint refuses resume without explicit stop
  confirmation;
- restored messages, whole-run budget counters, turn count, verifier cycle
  index, `completionCheckFailures`, verifier feedback, archived metrics, and
  results are exact and monotonic;
- `captureWorkerSessionSnapshot`/`restoreWorkerSession` and
  `captureRunBudgetSnapshot`/`createRunBudgetTracker({ restore })` round-trip
  through the checkpoint store exactly as their own existing unit tests
  already prove in isolation — this step tests the WIRING, not the
  primitives;
- the output-contract store's new rehydration path reproduces the exact
  in-memory history a non-restarted run would have built, from its
  `scratch/output-contract/revision-<n>.json` files;
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

This step implements Decisions 1–5. Both current worker registries get both
tools, in the same relative position (Decisions 1–2): the legacy
`createProductionRegistry` (still the production default,
`DEFAULT_TOOL_PROFILE = 'atomic'`) via `fileTools`, and `V2_TOOL_ORDER`. The
two resulting orders, written out in full so there is no ambiguity about
insertion points:

- **Legacy (14 tools, was 12):**
  `read_file, write_file, edit_file, grep, bash, navigate, inspect_page,
  click, type, scroll, screenshot, download, fill_credentials,
  ask_user_question`
- **V2 (24 tools, was 22):** unchanged except within the files group —
  `set_output_contract, upsert_output_rows, delete_output_rows,
  set_table_completeness, write_document, observe, browser_action,
  switch_page, handle_dialog, execute_javascript, read_resource,
  capture_text, inspect_document, screenshot, download, read_file,
  write_file, edit_file, grep, bash, fill_credentials, ask_user_question,
  run_research_jobs, submit_for_verification`

Both orders insert `edit_file` immediately after `write_file` and `bash`
immediately after `grep` (Decision 2's `read_file, write_file, edit_file,
grep, bash` files-group rule).

1. Validate `/bin/bash` is executable and create `scratch/workspace/` with
   mode `0700` before any initializer or worker model call.
2. Define one clearly named secret environment-variable denylist in
   `runTask.ts` and pass it into the Bash tool context/dependency. Cover model,
   tracing, credential-file, and other recognized application secrets.
3. Add optional `signal` to `RunTaskConfig`, pass it to `ToolCtx.abortSignal`,
   and have the TUI forward its existing run `AbortSignal`. This is the first
   consumer of the `ToolCtx.abortSignal` field Step 6 adds.
4. Register `editFileTool` immediately after `writeFileTool` in `fileTools`
   (feeds the legacy registry) AND at the corresponding position in
   `V2_TOOL_ORDER`/`V2_STATIC_TOOLS`.
5. Register `bashTool` directly after `grep` in `fileTools` AND at the
   corresponding position in `V2_TOOL_ORDER`/`V2_STATIC_TOOLS`, before
   browser tools in both. Do not create a `codeTools` group.
6. Per Decision 4, the initializer's and verifier's tool surfaces are
   otherwise UNCHANGED by this step — the initializer keeps its sole forced
   `set_output_contract` (`src/harness/initializer.ts:402-414`), the prose
   binding keeps `apiToolDefs: []` (`src/harness/initializer.ts:260-269`),
   and the verifier keeps `createRegistry([readFileTool, grepTool])`
   (`src/harness/verifierTools.ts:44-46`) plus its non-executing
   `report_verification`. Add an explicit regression test proving neither
   surface can invoke `edit_file` or `bash`. NO SUCH TEST EXISTS TODAY, so
   this is new coverage, not an update to an existing assertion — nothing
   currently pins the initializer/verifier tool lists the way
   `src/tools/index.test.ts` and `src/cli/systemPrompt.test.ts` pin the
   worker's.
7. Update `SYSTEM_PROMPT` with the short workspace, edit, Bash,
   `uses_browser`, publish, and post-Bash refresh guidance from the
   specification (`observe()`/`inspect_page`, per whichever registry is
   active — see Step 5, item 7). Keep it static.
8. Update BOTH pinned deterministic-order tests for the one intentional
   prefix change per registry (Decision 5):
   - `src/tools/index.test.ts` — the atomic-profile name list (12 → 14
     tools, matching the legacy order above) and the `V2_TOOL_ORDER` pin
     (22 → 24 tools, matching the V2 order above).
   - `src/cli/systemPrompt.test.ts:171-213` — the
     `toHaveLength(12)`/12-name-list assertion becomes `toHaveLength(14)`
     with the new 14-name list, keeping the byte-identical-cached-prefix
     assertion (`firstPrefix === secondPrefix` across unrelated task
     histories) intact and passing under the new tool set.
9. Update binding documentation in the same commit:
   - `AGENTS.md` line 28 — replace the absolute **"No `bash` tool ... Don't
     add one"** rule with the local, finite, worker-only contract (shell
     confined to `scratch/workspace/`, bounded in time and output, worker-only,
     reconciled into the manifest before the tool returns; initializer and
     verifier remain incapable of shell execution or file mutation);
   - `AGENTS.md` line 17 — the `writeArtifact`/`resolveRunPath`
     write/path-chokepoint rule needs an explicit exception documenting that
     `scratch/workspace/` reconciliation (Step 3's `syncScratchWorkspace`)
     is how bytes a Bash-spawned process wrote directly reach the manifest,
     since those bytes did not arrive through a tool calling
     `writeArtifact()` itself;
   - `docs/revised-browser-agent-implementation-plan.md` — this file already
     carries a 2026-08-13 "Superseded" callout after its intro
     acknowledging the worker-only `bash`/`edit_file` addition; confirm it
     stays consistent with whatever this step actually ships (tool names,
     confinement, initializer/verifier exclusion) rather than re-authoring
     it from scratch;
   - keep the initializer/verifier prohibition and the no-security-boundary
     warning in every document that states either.
10. Ensure the `.mjs` helper is included in the installed package by the
    existing `files` rules; add a package-content test only if the current
    packaging checks do not cover it.

#### Tests

- Exact legacy production tool order is `read_file`, `write_file`,
  `edit_file`, `grep`, `bash`, then the existing browser groups (14 tools
  total).
- Exact `V2_TOOL_ORDER` matches the 24-name list above.
- Repeated `toApiToolDefs()` calls are byte-identical, for both registries.
- TUI cancellation reaches an active Bash process group and checkpoint close
  waits for cleanup.
- Invalid shell/workspace/controller setup fails before the worker model call.
- Secret canaries do not appear in the child environment, transcript,
  checkpoint, manifest, or command output.
- NEW: initializer and verifier cannot invoke `edit_file` or `bash` (no
  equivalent test exists before this step).

#### Complete when

The worker sees the two tools in a stable prompt, cancellation reaches Bash,
and every binding document describes the behavior that is actually enabled.

**Suggested commit:** `agent: enable durable local code execution`

### Step 10 — End-to-end verification and handoff

Per Decision 6, this step is the SINGLE verification pass for the entire
feature: Steps 1–9 are implemented without running tests after each one, each
still landing as its own focused, reviewable commit, and this step is where
everything actually gets run — targeted suites first, then `npm run
typecheck`, then the broader repository run. This overrides the original
plan's rule 9 ("make each step a focused, reviewable commit after its tests
pass"); one commit per step is kept, but per-step test execution is deferred
to here.

#### Work

1. Add one hermetic fixture test that drives the real production worker tool
   registry through this sequence:
   - `write_file` creates `scratch/workspace/collect.mjs`;
   - `edit_file` makes one exact change;
   - `bash` with `uses_browser: true` runs it;
   - the script uses Playwright locators and writes intermediate JSON;
   - workspace sync manifests the script and JSON;
   - `inspect_page` (or `observe()`, on whichever registry the test targets)
     sees the changed page;
   - `write_file` publishes the requested output with its proper role.
2. Run the same scenario with a fault after Bash starts. Confirm resume refuses
   without stop confirmation, then continues without replay after the prior
   process tree is confirmed gone.
3. Review the implementation against every acceptance criterion in
   Specification §16 and record the test or code path proving each one.
4. Run targeted suites first, then `npm run typecheck`, then the broader
   repository gates:

   ```bash
   npm test -- src/run src/tools src/loop src/contracts src/harness \
     src/cli/runTask*.test.ts src/browser/playwrightBrowserController.test.ts
   npm run typecheck
   npm test
   git diff --check
   ```

   `npm test` is known to flake under parallel load, specifically on
   browser-teardown and TUI-timer suites (an existing, documented condition
   of this repository's test run, unrelated to this feature). Re-run any
   failing suite in isolation before treating it as a regression this
   feature introduced — do not chase a flake by weakening an assertion.
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

Per Decision 6, each step's tests are written alongside its commit but not run
until Step 10's single verification pass — so "should pass" is confirmed once,
at the end, rather than step by step. Steps 1–8 deliberately keep Bash out of
the production registry, so an intermediate checkout cannot advertise a
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
- Default-enabling `harness.outputContract` (Decision 3) — the V2 atomic →
  contract-first cutover is a separate decision from this feature.
- Closing `write_file`'s hole against writing a contract-bound filename
  directly (Step 2 closes it only for `edit_file`, the tool this feature
  adds).
- Consolidating the ad hoc manifest readers outside `loadManifest`/
  `readManifest` (`src/tui/bridge/tuiTracing.ts`, `src/tui/runScanner.ts`,
  `src/completion/finalizeIncompleteRun.ts`, and `validateManifestIntegrity`'s
  own inline parse) into one call site (Step 1).
