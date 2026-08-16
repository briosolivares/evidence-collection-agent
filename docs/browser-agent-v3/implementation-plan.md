# Sherlock v3 implementation plan and progress log

**Status:** complete for local/hermetic acceptance; live external checks are
explicitly deferred pending user authorization

**Last updated:** 2026-08-15

**Working branch:** `simplify/sherlock-core`

**Design authority:** [sherlock-v3-design-doc.md](./sherlock-v3-design-doc.md)

This file is the durable execution board for Sherlock v3. Update it after
every coherent implementation slice. A future coordinator or subagent should
read this file first, then the design document, then inspect the current
worktree before acting.

## Objective

Build the v3 evidence-collection agent described by the design document while
preserving these product contracts:

- the `sherlock` TUI and its ordered progress/artifact event stream;
- the streaming model/tool loop and prompt-cache discipline;
- local Chrome and the explicit Browserbase provider seam;
- the eval runners, oracle/grader boundary, authenticated lane, and reports;
- the self-contained durable run directory, manifest hashes, transcript,
  metrics, scratch workspace, and checkpoint state;
- deterministic output-shape checks and a fresh-context verifier because task
  accuracy remains the primary product metric;
- cancellation, human questions, Langfuse tracing, and provider-secret
  handling.

The implementation used a parallel v3 path rather than an in-place rewrite of
the legacy harness. New v3 modules reused stable seams without inheriting
initializer/contract/table/evidence/scheduler complexity merely to avoid
writing a smaller coherent replacement. After the new path passed its gates,
the public cutover and legacy-production removal were completed.

## Binding decisions

These decisions are made for the current implementation. Change one only by
updating the design and this plan in the same commit.

1. **One persistent worker conversation.** The worker keeps its full useful
   history across verifier corrections.
2. **Sequential tools.** Tool calls execute in response order. There is no
   access-key scheduler in the v3 loop. The generic pipeline's session-owned
   busy-resource registry remains only as a fail-closed timeout guard: if a
   timed-out promise may still be mutating a resource, a later conflicting
   call must not race it merely because v3 itself dispatches sequentially.
3. **Eight worker-visible capabilities.** `browser_execute`,
   `publish_artifact`, `read_file`, `write_file`, `edit_file`, `bash`,
   `ask_user`, and `finish`. Internals may use more modules; the model-facing
   surface stays compact and deterministically ordered.
4. **Programmable browser execution.** `browser_execute` runs bounded
   JavaScript in a fresh child process against a parent-owned, target-pinned
   CDP session. The child receives no CDP URL or provider credential. Local
   and Browserbase therefore use the same worker-visible contract.
5. **Editable helpers are run-local first.** Code under
   `scratch/workspace/` is durable for the run. Promotion to a shared helper
   library is never automatic: the worker publishes a proposed patch and a
   human applies it through normal review/Git history.
6. **Bash remains worker-only and finite.** No background commands, package
   installation, or remote sandbox is added. It remains an OS-user-level
   capability, not a security boundary.
7. **Contracts become immutable runtime guidance.** An initializer may derive
   the typed expected outputs before work begins, but the worker does not
   mutate contract revisions or maintain a typed-row database. Generic
   artifacts are validated directly at `finish`.
8. **`finish` is explicit and exclusive.** A prose-only assistant response is
   a working response. `finish` triggers deterministic manifest/output checks
   and then the existing fresh-context verifier. Findings return to the same
   conversation for correction.
9. **Durability is honest about uncertain effects.** The v3 checkpoint records
   every turn and tool boundary. A crash after a state-changing call begins
   but before its result is recorded does not replay the call blindly; resume
   reports the uncertain call and asks the worker to inspect current state.
10. **The run directory remains the output boundary.** Published artifacts
    live under `artifacts/` with non-empty roles. Private state lives under
    `scratch/`. Harness state lives under `harness/`. Graders receive only the
    run directory.
11. **Owned-tab cleanup is mandatory.** A run closes every task tab or popup it
    created, including failure/cancellation paths, while preserving pages that
    predated the run.
12. **No task-specific recipes in the core prompt or runtime.** Helper
    promotion is reviewed, general-purpose, and never silently injected based
    on an eval task name.
13. **No live eval re-baseline without user direction.** Hermetic tests and
    fixture-backed acceptance paths are permitted and required.

## Upstream reference pinned for this design

Reference checkout: `browser-use/browser-harness` main at
`6a80dbbce51e8c1776af061282546627f007be4e` (2026-08-15 UTC).

Borrow:

- a persistent browser transport beneath short-lived programmable scripts;
- raw CDP plus a small helper layer rather than an ever-growing action enum;
- a protected core and separately editable helper workspace;
- accessibility-first inspection, targeted DOM extraction, coordinate input,
  explicit waits, and raw CDP as the escape hatch;
- explicit local/remote selection and target identity.

Do not borrow:

- in-process `exec` of model-authored code;
- logging or exposing the CDP WebSocket capability;
- arbitrary output paths without a manifest;
- implicit first-tab recovery, page-title mutation, default telemetry of raw
  scripts/output, automatic shared-helper mutation, or site-specific recipes
  in the core;
- the absence of a model loop, artifacts, verifier, checkpoints, or evals.

## Verification baseline

Do not claim a baseline until the commands are run on the current checkout.

- [x] `npm run typecheck` — passed on the pre-v3-code checkout
- [x] `npm test` (requires local Chrome) — coordinator rerun passed all 1,833
  tests across 140 files in 68.87 seconds
- [x] record collected test count — 1,833 cases across 140 files
- [x] record production/test raw line counts using the same convention as
  `docs/reports/2026-08-14-simplification-audit.md` — 33,557 production
  `src` lines in 132 files; 36,458 test lines in 140 files
- [x] fixture-backed current application smoke path

A parallel audit observed one failure once in
`src/browser/playwrightBrowserController.test.ts`'s “fails
refreshAfterBrowserScript loudly when the script closes the whole browser”
case: production reported “The browser has been disconnected; the remote
session has ended...” while the assertion expected `browser session` or
`browser script`. The coordinator's independent full rerun passed that case
and all other 1,832 tests, so it is recorded as a possible flaky/stale-assertion
risk rather than a baseline failure.

## Dependency-ordered implementation steps

Each step must be reviewable and independently verified. Check a step only
when its code, tests, documentation, and named gate are all complete.

### Step 0 — design, contracts, and baseline

- [x] Expand `sherlock-v3-design-doc.md` into the binding product/runtime
  specification.
- [x] Create this durable implementation/progress file.
- [x] Record a requirement-to-evidence matrix for every preserved subsystem.
- [x] Run and record the current typecheck/full-test/application baseline.
- [x] Commit the documentation and baseline record as one scoped change.

**Gate:** the design names every model-visible tool schema, lifecycle state,
failure boundary, persistence file, provider rule, and cutover condition; the
baseline is reproducible.

### Step 1 — v3 browser execution substrate

- [x] Add a target-pinned CDP-session capability to `BrowserController` that
  never exposes a connection URL.
- [x] Implement it in `PlaywrightBrowserController` for both local and remote
  sessions.
- [x] Add the bounded child-process runner and private request/response IPC.
- [x] Add core helpers (`cdp`, `js`, page info, AX-tree filtering, navigation,
  coordinate click, typing, waits, tab listing/selection) on top of raw CDP.
- [x] Implement `browser_execute` with code, page target, timeout, stdout,
  stderr, return value, changed files, and post-run browser reconciliation.
- [x] Ensure cancellation kills the child; output/IPC payloads are bounded;
  secrets and CDP URLs never enter child env, logs, results, or artifacts.
- [x] Track and close all run-owned pages while preserving pre-existing pages.
- [x] Test local fixture behavior, stale target failure, dialog/error paths,
  timeout/cancellation, workspace changes, secret sweeps, and provider-neutral
  construction.

**Gate:** one fixture journey can navigate, inspect, interact, extract, open a
popup, and clean up using only `browser_execute`; the secret sweep passes.

### Step 2 — generic artifact and file surface

- [x] Implement `publish_artifact` modes for a workspace file, inline text,
  browser screenshot, and browser download.
- [x] Preserve exact bytes, manifest hashes, `requested_output`/`evidence`
  roles, source URL, and path confinement.
- [x] Keep `read_file`, `write_file`, and `edit_file`, simplified to the v3
  partition and without contract-owner special cases.
- [x] Keep bounded worker-only `bash`; reuse scratch reconciliation and browser
  access only through `browser_execute` (no CDP capability in child env).
- [x] Add `ask_user` over the existing permission/question bridge.
- [x] Add focused schema, partition, binary, overwrite, and cancellation tests.

**Gate:** CSV, Markdown/text, screenshot, and download artifacts can each be
published with correct manifest roles and verified hashes.

### Step 3 — v3 sequential worker session

- [x] Create a new v3 system prompt whose static prefix and tool order are
  deterministic.
- [x] Implement the single-conversation sequential loop over the existing
  strict streaming model driver.
- [x] Execute multiple tool calls in response order and return results in the
  same order.
- [x] Preserve result offloading, stale browser-result collapse, protocol
  correction limits, context/turn/wall/token budgets, transcript events, and
  metrics using smaller v3-owned state.
- [x] Treat zero-tool responses as working and accept completion only through
  the exclusive `finish` call.
- [x] Add snapshot/restore of v3 conversation state.

**Gate:** scripted model tests prove ordering, malformed-call recovery,
offloading, budget termination, explicit finish, cancellation, and byte-stable
prompt/tool definitions.

### Step 4 — finish checks, verifier loop, and durable coordinator

- [x] Run the contract initializer once; store one immutable typed contract in
  harness-private state and show it to the worker as per-run guidance.
- [x] Implement `finish` input (`summary`, unresolved limits) with published
  requested outputs derived from the authoritative manifest
  and interception in the v3 loop.
- [x] Adapt deterministic completion checks to generic published artifacts:
  exact filenames, exact CSV columns, row/count rules, non-placeholder
  content, requested screenshots/downloads, hashes, and roles.
- [x] Invoke the existing fresh-context verifier only after code checks pass;
  append check/verifier feedback to the same worker conversation.
- [x] Write a compact v3 checkpoint at turn/tool/verifying/terminal boundaries
  under `harness/checkpoint.json`, atomically and with a run lock.
- [x] Make manifest replacement atomic and durable (temporary file, fsync,
  rename, parent-directory fsync) so a killed writer cannot leave truncated
  provenance.
- [x] Implement resume, including explicit uncertain-effect recovery instead
  of blind tool replay.
- [x] Finalize transcript, metrics, manifest, tracing, and owned browser pages
  on success, incomplete exit, cancellation, and crash.

**Gate:** scripted end-to-end tests cover verified, deterministic rejection and
repair, verifier correction and repair, budget exhaustion, crash/resume at each
boundary, and cleanup on every terminal path.

### Step 5 — TUI and eval cutover

- [x] Preserve `runTask`'s public configuration/result seam or provide a thin
  compatibility adapter.
- [x] Make v3 the default for `sherlock`, `npm run agent`, demos that represent
  production, CLI evals, and TUI evals.
- [x] Preserve ordered progress, tool pending/result, question dialog,
  artifact-published, cancellation, browser death/relaunch, and terminal
  events.
- [x] Preserve headless parallel and headed serial eval lanes, login preflight,
  provider selection, grader inputs, report schema, and regrade behavior.
- [x] Add/adjust bridge and runner tests without pinning v3 private internals.

**Gate:** TUI and eval integration suites pass unchanged at their public
boundaries, and a fixture-backed `sherlock` run renders/publishes artifacts.

### Step 6 — retire legacy production mechanisms

- [x] Prove no production import reaches the legacy scheduler, mutable contract
  tool, typed row/evidence stores, document renderer tools, or old checkpoint
  replay path.
- [x] Remove unreachable production modules, demos, and tests that exist only
  for the retired path; keep reusable parsers/checks and historical reports.
- [x] Consolidate current documentation and update `AGENTS.md`, README, and the
  architecture summary so they describe v3 rather than the retired protocol.
- [x] Keep removals separate from v3 behavior changes and report structural
  versus cosmetic line reduction honestly.

**Gate:** semantic import search shows one production run path; no active docs
or prompts name removed tools/protocols; focused and full tests pass.

### Step 7 — final acceptance and completion audit

- [x] Run `npm run typecheck`.
- [x] Run the complete hermetic `npm test` suite.
- [x] Run direct fixture-backed acceptance journeys for table,
  screenshot/download, multi-page synthesis, human handoff, cancellation, and
  every named crash/resume boundary.
- [x] Evaluate the Browserbase smoke gate. It was not run because it is
  live/billable and the user did not authorize it; remote behavior remains
  explicitly unverified rather than inferred from fakes.
- [x] Run a secret sweep over representative run directories.
- [x] Inspect final diff, production import graph, tool order/schema snapshot,
  manifest outputs, transcript, metrics, checkpoints, and owned tabs.
- [x] Complete the requirement-to-evidence matrix with direct rather than
  inferred evidence.
- [x] Refresh final line/file/test deltas and residual risks after the added
  acceptance evidence.

**Gate:** every explicit objective and design requirement has direct current
evidence. Passing narrow tests alone is not completion.

## Requirement-to-evidence matrix

Populate evidence as steps land. `Pending` means the requirement is not yet
proved, even if supporting code already exists.

| Requirement | Authoritative evidence | Status |
| --- | --- | --- |
| Expanded v3 design | Design document reviewed against code | Complete; final API/module/authority drift closed |
| Durable step plan/progress | This file | Complete; maintained continuously |
| Browser-harness reference used | Pinned commit plus design adaptation table | Complete; official `6a80dbb` sources reverified |
| Programmable `browser_execute` | Tool tests + fixture acceptance transcript | Complete |
| Editable run helpers and reviewed promotion | Confined import/upload journey; static prompt; evidence-only patch/metadata finish test; verified TUI grouping | Complete |
| Compact v3 tool surface | Registry/schema snapshot | Complete for Step 3 |
| Sherlock TUI preserved | TUI integration suite + fixture smoke | Complete |
| Streaming main loop preserved | Model/loop tests + transcript | Complete; v3 is the sole production composition |
| Evals/graders preserved | Eval runner/grader suite + boundary inspection | Complete locally; no paid re-baseline run |
| Durable run directory preserved | Manifest/checkpoint/resume tests + representative terminal run inspection | Complete |
| Local + Browserbase seam preserved | Provider/command/upload/download contract tests | Complete hermetically; live Browserbase smoke remains unrun by explicit policy |
| Accuracy checks preserved | Deterministic rejection/repair and fresh-verifier correction tests | Complete |
| Owned tabs always cleaned | Terminal lifecycle + real SIGKILL attached-ownership tests | Complete |
| Secrets/CDP capability never leak | Child-env/redaction gate + recursive representative run-directory sentinel sweep | Complete locally |
| No task-specific logic | Production source/prompt/helper audit | Complete; no task-name/text dispatch branch |
| Full implementation complete | Steps 0–7 and final audit | Complete locally; external live measurements remain separately deferred |

## Progress log / handoff notes

### 2026-08-15 — resumed design and repository audit

- Confirmed branch `simplify/sherlock-core`; the only pre-existing untracked
  items were user-owned `docs/architecture-whiteboard.html` and
  `docs/browser-agent-v3/`.
- Read the repository instructions, checkpoint summary/handoff, current rough
  v3 brief, and simplification audit.
- Inspected the current tool registry, worker/harness composition, browser
  script support, run manifest, TUI bridge, and eval boundary.
- Audited upstream `browser-use/browser-harness` at commit `6a80dbb...`.
  Central conclusion: it is an execution substrate, not an agent. Sherlock
  should borrow its programmable CDP/helper split while retaining its own
  quality and evidence systems.
- User explicitly approved writing coherent v3 parts from scratch rather than
  forcing a large in-place refactor. The implementation strategy above now
  reflects that decision.
- No production code has been changed yet. No eval re-baseline has been run.
- A read-only preservation audit ran the current baseline: typecheck passed;
  Vitest collected 1,833 cases across 140 files, with 1,832 passing and the one
  stale browser-disconnect assertion described above failing. It also added
  required gates for TUI-to-grader visibility, popup cleanup, a real
  two-process crash/resume, full production tool-prefix stability, provider
  contracts, and fake eval CLI composition.
- Coordinator verification then ran `npm run typecheck` successfully and a
  complete `npm test`: 140 files and all 1,833 cases passed in 68.87 seconds.
  That suite includes the fixture-backed composition smoke in
  `src/cli/runTask.test.ts` (real local browser and production tool pipeline
  through a verified CSV artifact), so Step 0's application baseline is also
  complete; this is not a paid or live eval re-baseline.
  Baseline size under the audit's convention is 33,557 production `src` lines
  in 132 files and 36,458 test lines in 140 files.

### 2026-08-15 — Step 1 browser execution substrate complete

- Chose clean new v3 modules under `src/v3/browser/` for the program runner
  and protected helpers, while extending the existing provider-neutral
  controller seam only where browser ownership requires it.
- Added a URL-free, exact-target `BrowserCommandSession` to the provider seam;
  both managed local and Browserbase-backed Playwright controllers expose it.
  Stale ids fail closed and driver errors redact transport capabilities.
- Added a fresh-process v3 runner and protected CDP helpers under
  `src/v3/browser/`, plus the strict `browser_execute` tool under
  `src/v3/tools/`. Source/result/IPC/stdout/stderr/CDP-call budgets,
  cancellation, descendant cleanup, environment sanitization, page identity,
  workspace reconciliation, and browser refresh are covered.
- Native-dialog handling required one extra lifecycle rule discovered by the
  real browser gate: a timed-out renderer command transfers its CDP detacher
  to the controller until an explicit accept/dismiss decision. This prevents
  detach from silently dismissing the dialog and prevents cleanup from
  hanging behind it.
- Task ownership now includes the task page, owned-opener popups, and exact
  `Target.createTarget` receipts. `closeTaskPages()` drains page-event races,
  closes in reverse ownership order on run success/failure, and preserves all
  pre-existing and concurrently user-created pages. The existing `runTask`
  and resume cleanup now use this stronger operation.
- Added the attached-local provider foundation with a loopback-only explicit
  endpoint, all-pre-existing-page snapshot, endpoint-free diagnostics, and
  disconnect-only session close. Discovery and production provider selection
  remain intentionally deferred to the cutover step.
- The runner guarantees descendant-process cleanup on POSIX. The binding
  design now explicitly matches the existing `/bin/bash` support envelope:
  Windows fails before spawn until an owned Job Object (or equivalently tested
  process-tree mechanism) exists, rather than claiming an unsafe direct-child
  cleanup guarantee.
- Coordinator gates passed: `npm run typecheck`; focused runner/tool tests
  (26 cases); command-session tests (8); owned-page test (1); real
  `browser_execute` journeys (2, including timeout/dialog recovery); provider,
  tracing, and TUI regressions (87); and the real `runTask` popup-failure
  cleanup test. Final `npm test` passed 146 files / 1,884 tests in 54.78s.
- The first full run exposed the previously recorded stale browser-death
  wording assertion. Production now says "browser session has been
  disconnected," which remains recognized by the relaunch classifier; the
  targeted regression and final full suite are green.
- No live Browserbase smoke or eval re-baseline was run.

### 2026-08-15 — Step 2 generic artifact and file surface complete

- Split the new-file implementation into three non-overlapping slices:
  `publish_artifact`; simplified `read_file`/`write_file`/`edit_file`; and
  browser-free `bash` plus `ask_user`. The coordinator owns the shared-contract
  audit, combined acceptance gate, documentation, and commit.
- Integration invariants are fixed before merge: publication is the only route
  into `artifacts/`; editing tools write only under `scratch/`; file publication
  reads exact regular-file bytes only from `scratch/workspace/`; overwrite role
  equality is order-insensitive; browser capture checks cancellation before
  committing bytes; and no child environment receives browser/CDP helper
  capabilities.
- Added strict conditional publication schemas, exact-byte file/text/browser
  modes, role-set-stable overwrites, provider-derived browser provenance, and
  cancellation-before-commit. Source reads use no-follow descriptors; the
  coordinator applied the same descriptor-level hardening to private file-tool
  reads after review exposed a check/read gap.
- The private file tools now read only `artifacts/` or `scratch/`, mutate only
  `scratch/`, reject symlink components and non-regular/binary edit targets,
  preserve exact UTF-8 edit semantics, and route writes through the manifest.
  V3 `bash` reuses the proven process-group runner but has no browser schema or
  environment capability; `ask_user` keeps the existing fail-closed permission
  bridge with optional context and two to four unique choices.
- Coordinator gates passed: 51/51 new tests across five files, including the
  vertical CSV/Markdown/screenshot/download manifest re-hash; 136/136 focused
  legacy regressions; `npm run typecheck`; `git diff --check`; and the full
  hermetic suite, 151 files / 1,935 tests in 45.82 seconds.
- The TUI question dialog carries but does not yet render `ask_user.context`;
  that presentation update remains part of the production cutover. No live
  Browserbase smoke or eval re-baseline was run.

### 2026-08-15 — Step 3 sequential worker session complete

- The implementation is split into a static prompt/tool-prefix slice and a
  clean v3 session slice, with an independent preservation review of the
  current model driver, budget, transcript, result-offload, checkpoint-hook,
  and context-view contracts. No production composition cutover belongs in
  this step.
- The loop contract is fixed: accepted content blocks, never `stop_reason`,
  determine calls; ordinary calls execute strictly one at a time in response
  order; every call receives one ordered result; no-tool responses receive a
  short continuation prompt; and `finish` is accepted only as the sole call in
  a response. Deterministic checks and verifier authority remain Step 4.
- Only the two newest non-pipeline-error `browser_execute` results stay full in the
  model request view. Older results become deterministic identity/status/page
  stubs without mutating full conversation or transcript history.
- A preservation review corrected one over-broad simplification assumption:
  v3 removes the access-key scheduler, but retains the generic pipeline's
  session-owned timeout-abandonment registry. Sequential dispatch cannot make
  a timed-out promise stop running, so racing a later conflicting call would
  be unsafe even without intentional parallelism.
- Added one static `V3_SYSTEM_PROMPT`, a strict intercepted `finish` schema,
  the exact eight-tool `V3_TOOL_ORDER`, a run-scoped execution registry, and a
  deeply frozen process-wide `V3_API_TOOL_DEFS`. Independent constructions
  serialize byte-for-byte identically and contain no retired protocol names.
- Added a clean v3 worker session over `ModelDriver.generate`. It stores one
  full conversation, executes ordinary calls sequentially, answers every
  attempted call in order (including mixed-`finish` refusals), treats prose as
  continuation, and exposes exclusive validated `finish` requests to the
  Step 4 coordinator. Per-call lifecycle hooks persist `not_started`, a
  conservative pre-effect `uncertain` boundary, and bounded results; a
  post-effect persistence failure stops instead of inviting unsafe retry.
- Model accounting now separates aggregate known billable usage from the
  accepted request's context size. A complete `max_tokens` attempt plus its
  enlarged replacement is charged as one logical worker turn with both usage
  records, while peak context uses only the accepted response. If the
  replacement fails before reporting usage, a typed fatal error preserves the
  underlying cause and carries the first attempt's known usage for both v3
  and legacy role accounting. Attempts with no complete provider usage remain
  inherently unmeasurable.
- Added the pure v3 request view: only two newest non-pipeline-error
  `browser_execute` results remain expanded, older results become stable
  identity/status/page stubs, and full history is untouched. The shared model
  request builder now recognizes both legacy and v3 stubs as cache frontiers.
- Added a vertical scripted acceptance gate using the real v3 registry: it
  writes a private CSV, publishes exact bytes with requested-output/evidence
  roles and source provenance, verifies manifest hashes, restores the same
  conversation from a snapshot, continues after a prose-only turn, and ends
  only at an exclusive `finish` request.
- Coordinator gates passed: 106/106 focused prompt/registry/model/session/
  accounting tests; 140/140 focused v3 plus legacy loop regressions;
  `npm run typecheck`; `git diff --check`; and the complete hermetic suite,
  157 files / 1,976 tests in 43.64 seconds. No live Browserbase smoke or eval
  re-baseline was run.

### 2026-08-15 — Step 4 durable coordinator in progress

- Step 4 is split into three bounded foundations before composition: atomic
  manifest replacement; generic deterministic `finish` checks over the
  immutable output contract and manifest; and a compact version-3 checkpoint
  schema/store for turn, tool, checking, verifying, terminal, and uncertain
  effect state. The coordinator, verifier continuation, real process-kill
  resume gate, and all terminal cleanup remain coordinator-owned integration
  work after those foundations settle.
- No production entry point is cut over during these foundations. Existing
  v2 checkpoints/runs remain readable, and no live eval or Browserbase action
  is authorized by this step.
- Manifest creation, mutation, and finalization now use one durable atomic-file
  primitive. Replacement stages and fsyncs a same-directory inode before
  rename; first creation uses an exclusive hard-link publication so concurrent
  initializers retain the prior `wx` no-clobber contract. The helper also
  supports an exact `0600` mode for v3 checkpoints. Focused artifact/durability
  tests passed 54/54, broader manifest consumers passed 195/195, and typecheck
  plus whitespace checks passed.
- The remaining Step 4 foundations are implemented in the uncommitted v3
  path: one immutable two-attempt initializer and private
  `harness/output-contract.json`; generic no-write finish inspection over
  manifest bytes and contract shapes; a published-only, bounded, no-offload
  verifier registry; aggregate role-budget accounting; and a strict 0600
  phase-discriminated checkpoint store. Verifier recovery now records the
  honest `{ recovery: "restart_read_only" }` rule instead of synthetic private
  conversation state.
- The v3 coordinator now composes initializer → persistent worker →
  deterministic checks → fresh verifier, owns a fresh task tab lazily, and
  closes all task pages on terminal paths. It checkpoints accepted contracts
  before publishing their immutable file; links pending tool/finish cargo to
  the exact trailing assistant turn; reconciles `scratch/workspace/` before
  uncertain-tool recovery; verifies strong manifest shape/path/hash metadata
  even on terminal resume; reruns deterministic checks for recorded verified
  outcomes; and repairs a terminal transcript/manifest finalization window
  idempotently. Terminal finish failures are answered without ever publishing
  a transient `ready_for_model` checkpoint.
- Adversarial review found and the coordinator fixed an async-finally race:
  cancellation/failure branches must `await terminalize()` or the outer
  `finally` closes the checkpoint store before the terminal save. Current
  scripted gates pass 57/57 across coordinator happy path, deterministic and
  verifier repair loops, budgets, cancellation, browser cleanup, checkpoint
  integrity, and restored wall-clock downtime accounting; typecheck was green
  on that merged slice. A real two-process kill/resume suite and final
  transition/process-cleanup audit are still running, so Step 4 remains open.
- The real two-process gate is now active and green. It forks a new coordinator
  process, kills it with `SIGKILL`, then resumes under a different PID at the
  accepted-contract, uncertain-effect, and private-verifier boundaries. The
  uncertain effect is never replayed; verifier model/tool spend is checkpointed
  per accepted response and rebilled on its read-only retry; the terminal
  checkpoint retains exact `finish` claims; one terminal transcript event and
  no run lock survive. The current crash/accounting subset passes 33/33.
- Artifact publication is now a recoverable bytes-plus-manifest transaction.
  A 0600 intent under `harness/artifact-write-journal/` precedes atomic target
  replacement; recovery under the run lock commits the exact intended entry
  only when no-follow length/hash checks match, otherwise preserves prior
  manifest truth and removes only transaction-owned staging state. The
  coordinator runs this recovery before any resume inspection. Real kill and
  merged artifact/coordinator gates currently pass 69/69.
- Completion now shares the worker's abandoned-resource ledger with the browser.
  `finish` checks wait for exclusive quiescence, terminalization refuses to
  finalize while a timed-out effect remains live, and delayed-writer tests prove
  both verification and incomplete finalization see settled bytes. Browser page
  cleanup has its own finite deadline, so a wedged controller produces a failed
  outcome without suppressing durable terminal state.
- Initializer, worker, and verifier activity consume one monotone budget.
  Initializer control calls and verifier inspection/verdict calls are counted;
  every model-visible verifier result is charged; initializer budget exhaustion
  can terminalize without inventing a contract/worker; and verifier accounting
  is checkpointed after each model/tool mutation. Metrics, transcript, and
  manifest are independent terminal projections: resume reconstructs missing
  metrics, repairs only an unterminated JSONL tail, and attempts all finalizers
  even when one remains corrupt. The current focused coordinator/checkpoint/
  verifier set passes 103/103 and typecheck is green.
- Step 4 remains open on two external-liveness gates: a detached Bash/browser
  child must be killed when its harness parent is `SIGKILL`ed, and an attached
  Chrome reconnect must reclaim/close stale pages from the same durable run
  while preserving unrelated user tabs. Both have isolated implementations
  and real-process tests in progress; no production cutover or live eval has
  started.
- Durable attached-browser ownership is now implemented and wired before the
  coordinator opens any task tab. A namespace-separated hash, never the raw
  run path, is installed as a non-enumerable/non-writable/non-configurable
  page property before site JavaScript. Real Chrome process-kill/reconnect
  tests reclaim a same-run main tab and `noopener` popup across origins while
  preserving wrong-run and user tabs; the merged ownership/lifecycle subset
  currently passes 14/14.
- Worker model accounting now has its own awaited checkpoint boundary before
  cancellation or response content can win, and a valid `finish` passes the
  same turn/token/context guard as every other accepted response. A new real
  process-kill test proves one accepted worker response remains billed after
  restart and its retry is billed again; the merged worker/crash/checkpoint
  subset passes 79/79.
- Stale run-lock takeover now uses a separate exclusive recovery guard and
  re-reads the exact prior owner before unlinking. A simultaneous contender
  fails closed instead of deleting the winner's live lock, interrupted
  takeover guards are never guessed away, and lock-release failures surface;
  the checkpoint suite currently passes 47/47.
- The last Step 4 audit is addressing three bounded gaps before the full gate:
  parent-death supervision must hard-kill without a resume overlap window;
  manifest inspection needs canonical timestamps and aggregate memory/count
  bounds; and finite whole-run wall time must interrupt even non-cooperative
  model/provider calls. These remain uncommitted and keep Step 4 open.
- The finite whole-run deadline slice is now implemented and focused-gated.
  One restored absolute wall deadline is composed with operator cancellation
  and races initializer, worker, verifier, checking-phase resource waits, and
  controller-owned task-page preparation while still passing the signal into
  cooperative providers. Known model usage crosses its awaited accounting
  checkpoint before cancellation wins; wall expiry durably classifies as
  `incomplete/budget_exceeded:wall_time`, while only the composed run signal
  can classify operator cancellation. Interrupted verifier finishes receive
  exactly one terminal error result. Playwright keeps exact late page creation,
  durable claims, ownership initialization, and navigation behind both its tab
  lifecycle and the shared exclusive abandoned-effect fence; terminalization
  either observes containment or refuses to finalize after its separate finite
  safety gate. Busy waits now cancel and clear losing timers. The merged
  registry/budget/model/worker/verifier/checkpoint/coordinator/browser gate
  passes 201/201 across 13 files, real Chrome semantics included; typecheck and
  `git diff --check` are green. Step 4 remains open for the other audit slices
  and the final full gate.
- The follow-up resume/terminal audit is now implemented. Artifact recovery
  bounds manifest/journal reads before allocation and polls a trusted guard
  during directory and 64 KiB hash chunks; active resume uses the restored run
  deadline, terminal resume has an independent 30-second integrity bound, and
  workspace reconciliation polls the same guard while walking and reading.
  The v3 verifier supplies a filesystem-free opening from the task, immutable
  contract, finish claims, clarifications, and settled facts, so hostile
  unmanifested trees cannot run ahead of its bounded no-follow tools. A
  verified verdict is rechecked for cancellation/hard limits after resource
  drain and browser cleanup. If the finite abandoned-effect gate expires,
  terminalization retains the run lock and performs a fixed-point drain rather
  than exposing an overlapping resume window. New regressions cover an
  unmanifested symlink cycle, cleanup-time cancellation/wall expiry, terminal
  inspection expiry, chunk-level guard propagation, and a competing
  coordinator while an effect remains live. The focused regressions are
  98/98, and the broader affected v3/run/verifier/tool set is 352/352; full
  typecheck and `git diff --check` are green. Step 4 remains open only for the
  in-progress target-sentinel/browser crash gate and then the merged full
  suite.
- Browser ownership now rotates explicit epochs only after `closeTaskPages()`
  disposes the exact context init-script handle and reaches two clean bounded
  inventory passes; cleanup failure remains bound/poisoned, and real A→B reuse
  preserves user tabs. Providers inject a context-scoped opaque Chromium
  target control; V3 task preparation creates an exact hashed sentinel target,
  claims/marks its exact Playwright page before stripping the sentinel, and
  routes run-owned raw target creation and unresponsive-page replacement
  through the same path. Attached Chrome uses a dedicated excluded anchor so
  reclaiming a stale task page cannot detach target inventory mid-cleanup.
  The focused controller/provider/real-Chrome gate passes 82/82 across seven
  files with one worker, and typecheck plus `git diff --check` are green. The
  dedicated SIGKILL-at-post-create/pre-marker sentinel regression remains to
  be added. A narrower provider-internal residual also remains: `context.newPage`
  can commit the attached target-control anchor before the provider can retain
  or tag it, so SIGKILL in that setup window may leave one unclassified blank
  internal page; the real crash test distinguishes that page from run-owned
  pages rather than guessing it is safe to close.
- The browser crash follow-up closes both residuals above. Attached Chrome now
  binds its context-scoped target inventory through Playwright's browser-level
  CDP session, so provider setup creates no internal page and has no blank-page
  SIGKILL window. A deterministic real-process fixture stops immediately after
  `Target.createTarget` returns the exact hashed sentinel target and before any
  Playwright page claim or ownership marker; after SIGKILL, a wrong run leaves
  that target and both user tabs untouched, while a same-run resume reclaims
  only the sentinel. The serial focused controller/provider/real-Chrome gate
  passes 84/84 across seven files; full typecheck and `git diff --check` are
  green.
- The final bounded-inspection pass caps one table at 16 MiB, 100,000 data
  rows, 1,000,000 header/data cells, and 100 deterministic defects. The run
  guard is polled during parsing, normalization, and rule/cell validation, and
  exact cancellation/deadline values propagate unchanged. The focused finish
  and coordinator tests pass 64/64; the merged completion/coordinator gate
  passes 85/85.
- Bash and browser-program children are now armed behind an independent
  parent-death supervisor before model-authored code can execute. Parent IPC
  loss hard-kills the complete POSIX process group; watchdog failure inside a
  live harness also hard-kills synchronously and overrides any softer outcome.
  Real SIGKILL fixtures prove a target and descendant cannot outlive the run
  lock or overwrite a replacement effect. The containment gate passes 42/42.
- The final integration review fixed one action-ordering race: after a browser
  action, the controller now yields once and drains page-ownership claims
  before the sequencer decides whether a popup interrupted the remaining
  actions. This preserves the short generic navigation window without letting
  a slow durable popup claim expose the next action to the wrong page state.
- Step 4's merged affected gate passes 418/418 tests across 25 files. The
  serial target-control/provider/real-Chrome ownership gate passes 84/84, and
  the real coordinator kill/restart gate passes 7/7. `npm run typecheck` and
  `git diff --check` pass. The complete default-parallel hermetic suite passes
  174 files / 2,226 tests in 93.24 seconds. No live Browserbase smoke or eval
  re-baseline was run.
- To recover enough disk for the complete gate, the coordinator removed only
  explicitly inspected stale test directories: four `/private/tmp/sherlock-*`
  directories dated August 12–13 and Chrome test profiles older than four
  hours under the exact process temp directory. Those temporary files are not
  recoverable; no run directory, persistent Chrome profile, source file, or
  user-owned whiteboard was removed.

### 2026-08-15 — Step 5 production cutover complete

- Public outcome decision: preserve every truthful durable v3 `incomplete`
  reason (`initializer_unavailable`, `worker_incomplete`, deterministic-check
  exhaustion, verifier exhaustion, and budget exhaustion) through `runTask`
  and the TUI. Do not collapse initializer/worker unavailability into a
  generic thrown `run_failed`; callers receive the terminal state recorded in
  checkpoint, metrics, transcript, and manifest.

- The read-only resume router now identifies checkpoint v1 versus v3 without
  taking or changing a run lock. V3 configuration loading shares the bounded,
  no-follow checkpoint reader, validates the complete snapshot, and returns a
  recursively frozen durable configuration. The checkpoint/coordinator gate
  passes 92/92.
- V3 JavaScript policy is now a required run-scoped registry dependency. A
  deny decision blocks the complete `browser_execute` authority before any
  browser, CDP, child, workspace, or environment access while leaving the
  static eight-tool prompt prefix byte-identical. Per-run worker guidance
  states the resolved provider, authentication state, and policy outside that
  cached prefix. The focused policy gate passes 14/14.
- A new `runTaskV3` composition adapter now builds finite durable defaults,
  the immutable initializer, byte-stable v3 worker driver/tool registry, fresh
  verifier, tracing/progress bridges, and the durable coordinator. Public
  `runTask` defaults to v3; a temporary explicit legacy selector preserves
  tests and the worker-authored contract option until Step 6 deletes both.
  `resumeTask` routes only from the durable checkpoint discriminator. TUI,
  REPL, demo 12, and CLI eval composition now state authenticated JavaScript
  authority explicitly and forward cancellation through eval trials.
- TUI compatibility updates recognize all v3 tool names, retain manifest-
  derived publication events, classify finalized runs from manifest plus
  terminal metrics, preserve incomplete diagnostics, and recycle controllers
  poisoned by page-cleanup failures. Cancellation cannot mask a poisoned-page
  cleanup error, and intercepted `finish` calls settle as successful/error
  control flow rather than false retried warnings.
- The public v3 adapter has direct tests for finite defaults, publication and
  verification, JavaScript denial, truthful initializer incompletion,
  authenticated resume authority, terminal no-effect/no-trace resume, v1
  routing, and rejection of v3-only budgets on the rollback route. A real
  local-Chrome fixture journey drives `browser_execute` →
  `publish_artifact` → `finish` → fresh verification, and a TUI vertical test
  proves ordered run-directory, pending/execution, manifest-derived artifact,
  finish, and completion events through the reducer.
- Final gates: the Step 5 affected suite passed 730/730 before the last two
  focused TUI fixes; their merged focused gate passed 99/99, the real-browser
  `runTask` suite passed 13/13 serially, `npm run typecheck` and
  `git diff --check` passed, and the complete hermetic suite passed 175 files
  / 2,265 tests in 94.39 seconds. Three independent final read-only audits
  found no surviving P0/P1 issue in adapter/security, resume/checkpoint, or
  TUI/eval compatibility. No live Browserbase smoke or eval re-baseline ran.
- Full-suite concurrency exposed a test-only PID-file readiness race in the
  parent-death watchdog gate (directory-entry visibility preceded contents).
  The poll now waits for complete parseable PIDs; its focused serial gate and
  both subsequent complete suites pass.

### 2026-08-15 — Step 6 retirement preflight

- Step 5 is committed at `071a9ec`. The rollback point is green: 175 test
  files / 2,265 tests, `npm run typecheck`, and `git diff --check` all pass.
  The execution board is 43/55 checked items (78%) before Step 6 removals.
- Use the raw physical-line convention from
  `docs/reports/2026-08-14-simplification-audit.md`; do not count generated or
  vendor code and do not claim comment/format churn as structural savings.
  The post-cutover coexistence baseline is 579 tracked files, 51,209
  production `src` lines across 167 files, 51,885 test lines across 175 test
  files, and 12,877 `evals` lines. The pre-v3 production baseline was 33,557
  lines across 132 files, so the temporary duplicate runtime is visible and
  intentional rather than hidden in a net number.
- A TypeScript-aware `madge` import graph was generated from the actual
  production roots and cross-checked with `rg`; `tsc` with unused-symbol
  diagnostics was also run as a secondary signal. Replacing the legacy
  dispatcher with the v3-only public composition and retiring legacy-only
  demos exposes at least 26 direct production deletion candidates totaling
  about 6,489 raw lines. Dynamic child/helper modules and the attached-local
  provider are explicit false positives and must be retained.
- The first coherent retirement slices are: migrate the TUI's remaining type
  imports to v3, make `runTask` a v3-only public seam, remove the worker-authored
  contract/legacy-checkpoint rollback route, then delete only modules and
  demos that the semantic graph proves unreachable. Reusable parsers,
  provider/controller seams, run provenance, eval boundaries, and the TUI are
  product floor, not reduction targets.
- One behavior gap was found before deletion: the attached-local provider has
  crash/ownership coverage but was never selected by the production
  interactive local path. Close that design requirement in a separate
  behavior commit (interactive local defaults attached; evals/tests remain
  explicitly managed; Browserbase is unchanged) before structural removal.
  This keeps behavior changes reviewable independently from the legacy SLOC
  reduction.

### 2026-08-15 — binding §7.1 attached-local cutover ready

- `SHERLOCK_BROWSER_PROVIDER` remains the sole local-versus-Browserbase
  switch. Provider composition now requires an explicit local mode:
  interactive `sherlock` chooses `attached`; the REPL, demos, login, and all
  local eval/test adapters choose or directly construct `managed` Chrome.
  Local TUI evals lease the managed eval runtime even though interactive runs
  use attached Chrome; Browserbase headed-session reuse is unchanged.
- Attached setup probes the optional loopback-only
  `SHERLOCK_CHROME_CDP_ENDPOINT`, then Chrome stable's bounded
  `DevToolsActivePort` discovery. A missing or stale endpoint opens
  `chrome://inspect/#remote-debugging`, names the exact control to enable, and
  waits for the human under finite setup, port-probe, and connection budgets.
  Sherlock never clicks the permission prompt.
- Local attachment completes before Ink renders and the TUI runtime owns that
  controller even when no task starts. The attached provider uses Playwright's
  `noDefaults` mode, snapshots all existing pages, creates no setup page, and
  disconnects without closing user Chrome. Endpoint values are redacted from
  setup/errors/diagnostics and stripped from both legacy and v3 child-process
  environments.
- Focused gate: 151/151 tests passed across attached setup/provider,
  composition, manual-Chrome resolution, legacy/v3 environment redaction,
  eval-browser policy, and TUI browser lifecycle. `git diff --check` passed.
  The last global `npm run typecheck` before the coordinator's concurrent
  Step 6 legacy deletions was green; current global diagnostics are confined
  to that in-progress `contractAuthor` removal, not this slice.
- Deliberately unexercised external UX: no test attached to or opened the
  developer's real daily Chrome. Automatic discovery currently targets the
  stable default Chrome profile supported by Chrome 144+; another channel or
  nonstandard profile uses the explicit loopback endpoint escape hatch. No
  live Browserbase smoke or eval re-baseline ran.

### 2026-08-15 — Step 6 immediate legacy closure removed

- After the v3-only `runTask` seam landed, the semantic import graph proved the
  old scheduler/session, mutable contract authoring path, v1 checkpoint replay,
  legacy composition root, and their wrapper tools unreachable. This slice
  removes 67 files and 17,953 raw lines while retaining the generic tool
  registry/pipeline, bounded foreground-command runner, browser/controller
  seams, provenance layer, and every v3 implementation.
- Measured against the Step 6 coexistence baseline, the live production
  `src` tree is now 41,298 raw lines across 130 files (down 9,911 lines and 37
  files); the test tree is 35,971 raw lines across 111 files (down 15,914 lines
  and 64 files). Those category deltas overlap neither generated nor vendor
  code; the total patch also includes retired demos and two small model-frontier
  cleanups. No comment-only or formatting reduction is counted as structural.
- The retained-result cache frontier now recognizes the sole v3 collapsed
  browser-result marker; the deleted legacy marker and its redundant tests are
  gone. `npm run typecheck -- --pretty false`, `git diff --check`, and a focused
  15-file gate covering model calls, generic tool infrastructure, v3 tools,
  worker/coordinator, tracing, and TUI all pass (242/242 tests).
- The remaining retirement boundary is deliberate: the v3 verifier still
  imports the old generic verifier loop/image inspection, and `ToolCtx` still
  carries the typed output-contract store. Those dependencies must be folded
  into cohesive v3/shared seams before deleting the typed row/evidence stores
  and document renderer; none of that code was deleted speculatively.

### 2026-08-15 — Step 6 verifier and typed-store closure removed

- V3 now owns its complete verifier boundary: verdict schema, exclusive report
  tool, fail-closed repair/context loop, bounded read-only inspection, and
  PNG/JPEG validation. Compact v3 tests retain the old safety locks for prose,
  malformed/mixed reports, forced reporting, cancellation, aggregate billing,
  no-follow reads, image limits, and durable accounting.
- With those imports removed, the mutable contract store/gate, typed table and
  evidence stores, completion renderer, document source/renderer, and the old
  verifier/read/grep stack were semantically closed and deleted. The live
  Browserbase smoke still exercises real PDF generation, now directly through
  its existing fresh Playwright page seam rather than importing a retired
  document renderer.
- This slice adds 719 lines of cohesive v3 tests/implementation and deletes
  8,503 lines, net -7,784. The live production `src` tree is now 36,994 raw
  lines across 117 files; tests are 32,482 lines across 99 files. Relative to
  the post-cutover coexistence baseline, production is down 14,215 lines and
  50 files; tests are down 19,403 lines and 76 files.
- `npm run typecheck -- --pretty false`, `git diff --check`, and a 17-file
  impact gate spanning verifier/initializer/completion, worker/coordinator,
  generic registry/pipeline, browser providers, public composition, tracing,
  and TUI all pass (349/349 tests). Active documentation consolidation and
  the complete acceptance suite remain before Step 6/7 can close.

### 2026-08-15 — TUI semantics reduced to the v3 surface

- The semantic activity mapper, demo transcript, terminal-control handling,
  and their fixtures now name only the eight frozen v3 worker tools. Removed
  mappings and assertions for the retired scheduler-era tool set rather than
  carrying a compatibility table no live or historical run scanner consumes.
- This focused slice removes 159 production lines and 254 test lines net from
  the TUI semantic boundary while retaining manifest-derived publication as
  the authoritative artifact signal.
- The complete TUI gate passes 28 files / 324 tests. `npm run typecheck` and
  `git diff --check` also pass; no live browser, model, eval, or remote service
  was invoked.

### 2026-08-15 — legacy browser-script transport removed

- Removed the second-Playwright-client browser-script helper/setup, its CDP
  endpoint export and pairing lifecycle, and the managed-provider endpoint
  polling that existed only for that retired path. V3 keeps the protected,
  target-pinned `openCommandSession` and `refreshAfterExternalCommands`
  boundary used by `browser_execute` on every provider.
- Loopback endpoint validation is now a small provider-facing helper. External
  command reconciliation remains ownership-aware, invalidates stale
  observations, and restores a usable owned page without adopting ambient user
  tabs.
- The slice removes 1,253 net lines across 14 files. The complete serial
  browser gate passes 15 files / 234 tests; `npm run typecheck` and
  `git diff --check` pass. Browserbase smoke was updated structurally but the
  live/billable command was not run.

### 2026-08-15 — immutable contract schema simplified

- Replaced the retired revision/basis validator and canonical revision
  serializer with `validateOutputContract`, which parses the one initializer-
  authored immutable contract and applies the same cross-field checks and
  defaults directly.
- The initializer's strict `{contract}` call shape remains its own static API;
  invalid shape or cross-field requirements receive one bounded repair. No
  mutable contract history or worker revision concept remains.
- The change removes 232 net lines across four files. A seven-file contract,
  initializer, output-contract-file, checkpoint, coordinator, lifecycle, and
  real crash/resume gate passes 132 tests; `npm run typecheck` and
  `git diff --check` pass.

### 2026-08-15 — final parity audit (open before acceptance)

- The semantic deletion pass found two browser capabilities that are still
  implemented below the controller but are not reachable through the v3
  worker surface: remote-safe file upload, and click/blob download capture.
  `browser_execute` currently exposes neither upload nor a parent helper;
  `publish_artifact`'s `ref` mode expects a retired observation ref that the
  v3 worker cannot produce. These are acceptance blockers, not documentation
  exceptions.
- A direct runner probe also confirmed that `await import('./helper.mjs')`
  resolves relative to the static child module, not `scratch/workspace/`; the
  promised run-local helper import needs an explicit confined loader and test.
  The audit is still checking whether verified helper proposals are
  distinguishable in the TUI. Do not delete retained upload/download provider
  strategies until the v3 replacement seams and fixture tests land.

### 2026-08-15 — verified helper proposals separated in the TUI

- The completed-run artifact summary now keeps
  `artifacts/helper-proposals/**` in a distinct final group and labels it
  `Verified helper proposals`, even if a task explicitly requested the patch.
  Requested outputs and ordinary evidence retain their relative publish order.
- Live and incomplete/cancelled artifact surfaces deliberately do not use the
  verified label: the files remain visible evidence candidates, but only a
  verified run makes them review-ready proposals.
- Focused reducer and Ink gates pass: 2 files / 97 tests. Run-local import and
  the browser upload/download parity work remain open before the full editable
  helper lifecycle is complete.

### 2026-08-15 — orphan content-reader and adapter island removed

- Deleted the unreachable OCR, PDF, and spreadsheet reader registries and
  retained only the byte-based `detectContentFormat` helper used by the v3
  worker/verifier. Removed `exceljs`, `pdfjs-dist`, and `tesseract.js`, dropping
  111 installed transitive packages.
- Removed additional proven-dead adapters and aliases: the old local-execution
  preflight shell, artifact completion-status mutator, legacy budget wrapper,
  cycle-start transcript type, URL formatter, file-tool bundle alias, and
  unused contract/verifier type aliases. The secret environment denylist moved
  intact beside the v3 tools that consume it.
- Structural delta: 47 additions / 1,691 deletions in production+test code
  (net -1,644), plus 1,342 package/lock lines removed (overall net -2,986).
  Focused gate: 10 files / 134 tests; typecheck, dependency tree, npm audit,
  stale-symbol/import scan, and diff check all pass. Commit `41222a6`.
- A follow-up import audit removed four more zero-caller dependencies:
  `@date-fns/tz`, `csv-stringify`, `ink-select-input`, and
  `@opentelemetry/sdk-node`. That dropped another 58 installed packages and
  730 net package/lock lines; `npm ls --depth=0`, typecheck, npm audit, and
  diff check pass. Commit `f801205`.

### 2026-08-15 — protected run-local helpers and upload parity complete

- Added `browser.importModule(workspacePath)` for bounded, entry-confined
  run-local modules and `browser.upload(backendDOMNodeId, workspacePath)` over
  strict host IPC. Upload paths are confined to `scratch/workspace`, validated
  as no-follow regular files with a 64 MiB ceiling, then encoded through the
  provider strategy so Browserbase receives bytes rather than local paths.
- Upload targets the exact page/backend node through the pinned command
  session, cleans its temporary marker/object, and exposes no CDP URL or
  provider authority. IPC is bounded to 32 calls / 8 pending / 4 KiB paths.
  A timed-out child cannot orphan an upload: the session drains in-flight
  uploads before detach/refresh and the shared exclusive busy ledger fences
  later work until the real effect settles.
- Gates: helper/tool/prompt 40/40, command session 12/12, local review gate
  52/52, real Chrome import+upload journey, typecheck, and diff check pass.
  Live Browserbase remains intentionally unrun; its byte encoder is covered by
  a fake. Commit `d83f2cd`.
- The real-browser gate exposed a pre-existing raw-target delivery race:
  `Target.createTarget` could answer just before Playwright published its Page.
  Registration now waits within a bounded 2-second poll window. The complete
  three-test browser_execute journey passed three consecutive serial reruns;
  typecheck and diff check pass. Commit `83e7e39`.
- Residual documented limits: entry validation closes its descriptor before
  Node import/Playwright consumption, leaving a narrow same-user TOCTOU window;
  nested imports use normal Node resolution and are not recursively confined.
  This runtime is explicitly not an OS security boundary.

### 2026-08-15 — backend-node download parity complete

- Replaced `publish_artifact`'s unreachable legacy observation-ref input with
  `backend_node_id`, the exact integer identity returned by the v3
  accessibility helper. Direct HTTP(S) URL capture remains available.
- Upload and download now share one exact backend-node-to-locator primitive.
  It resolves through the target-pinned CDP session, installs a unique
  temporary marker across frames, releases the remote object, and removes the
  marker on every exit path. Generated/blob controls are clicked with the
  provider-injected download reader, so local file reads and Browserbase byte
  retrieval retain the same controller boundary.
- The real Chrome vertical journey navigates through an authenticated fixture,
  obtains the button's backend node via `browser_execute`, publishes its exact
  generated bytes with both manifest roles and browser-derived provenance, and
  proves marker cleanup. Unit/session gates pass 32/32, the serial real-browser
  gate passes 4/4, typecheck and diff check pass. Live Browserbase remains
  intentionally unrun.

### 2026-08-15 — Browserbase smoke and controller demo migrated to v3

- Rewrote the live Browserbase smoke driver around durable task-page
  preparation and target-pinned command sessions. Fixture discovery now uses
  the accessibility tree's backend node ids; fill uses raw CDP; upload uses
  the protected byte/path encoder; generated downloads use the same backend
  node accepted by `publish_artifact`; PDF evidence uses `Page.printToPDF`.
- Context-persistence writer and reader sessions now use the same v3 page
  lifecycle and explicitly drain command sessions/task pages before closing.
  The local controller demo likewise exercises the v3 preparation and command
  seam rather than the retired observation/action methods.
- `npm run typecheck`, the stale-call scan, and scoped diff check pass. The
  live smoke was not run because it consumes Browserbase minutes and remains
  gated on explicit user direction.

### 2026-08-15 — legacy browser action stack removed

- Removed the unreachable observation/action/ref/evaluate implementation:
  `browserActions`, `browserState`, `pageElementRefs`, `pageJavaScript`, and
  their legacy controller tests. `BrowserController` is now the v3 runtime
  contract only: durable task-page preparation/cleanup, target-pinned command
  sessions, safe page summaries, dialogs, screenshots, downloads, and
  provider diagnostics. JavaScript policy remains a separate 20-line durable
  authority check.
- Replaced old controller-facing test setup with production-faithful durable
  preparation. Existing ownership/provider/command suites retain popup,
  target, dialog, upload, cancellation, attached-Chrome, and SIGKILL coverage;
  real publication journeys now pin exact generated-download bytes and a
  full-page PNG with browser-derived provenance.
- The real browser gate exposed and fixed one ownership race: refresh was
  reinstalling a durable marker on an already-owned page, so an outstanding
  native dialog could block that unnecessary renderer evaluation and close
  the page. Refresh now claims only newly discovered pages. Command sessions
  also report raw commands abandoned at child timeout; the controller retires
  that exact owned page and creates a durable replacement. A real infinite
  `Runtime.evaluate` regression proves the following `browser_execute`
  succeeds.
- Structural code delta for this slice is +530/-5,959 raw lines (net -5,429):
  production +248/-4,463 (net -4,215), tests +282/-1,496 (net -1,214). The
  live tree is 31,680 production lines across 111 files; the slice handoff's
  30,391-line/95-file test subtotal covered `src/` plus `tests/` but omitted
  `evals/`. The final Step 7 record below restores the binding all-test-files
  convention rather than comparing that subtotal with the full baseline.
  Relative to the Step 6 coexistence baseline, production is down 19,529
  lines/56 files.
- `npm run typecheck`, the retired-symbol scan, and `git diff --check` pass.
  The serial local-Chrome/browser impact gate passes 15 files / 139 tests.
  No live Browserbase session or eval re-baseline ran.

### 2026-08-15 — active documentation consolidated

- Rewrote `AGENTS.md`, README, the retained demo guide, and all nine active
  `.agents/summary/` documents around the sole v3 production path, static
  eight-tool surface, immutable contract, durable coordinator, attached versus
  managed browser ownership, and current provider/eval boundaries.
- Marked the superseded v2 proposal/implementation documents as historical
  without rewriting their dated delivery record. Updated the Browserbase plan
  to describe the protected target-pinned command bridge that replaced its
  deferred secondary-client proposal.
- Removed stale references to retired controller actions, old completion and
  contract protocols, deleted stores/readers, and dependencies already removed
  from the package graph. The active-doc removed-symbol scan is empty, and all
  relative Markdown link targets resolve. Typecheck and the complete hermetic
  test suite remain the Step 7 gate.

### 2026-08-15 — Step 7 final acceptance complete

- Final clean-tree gates pass: `npm run typecheck -- --pretty false`, then the
  complete hermetic suite at 131/131 files and 1,465/1,465 tests in 53.63s.
  The explicit serial acceptance group passes 8 files / 46 tests and covers a
  real table run, multi-page browser synthesis, screenshot and generated/blob
  download publication, human handoff, cancellation, deterministic/verifier
  repairs, process crash/resume, and attached-page reclamation after SIGKILL.
- A representative public run now recursively sweeps every regular file for
  an ambient Browserbase-key sentinel and finds none. The same run verifies
  exact artifact bytes/hash/roles, a finalized manifest, ordered transcript,
  terminal metrics and v3 checkpoint, immutable contract projection, an empty
  artifact journal, a released run lock, and no remaining owned task page.
  The broader child-env/provider/redaction gate passes 8 files / 127 tests.
- The static tool/schema gate passes 3 files / 13 tests. Tool registry order
  and API-definition order are both exactly `browser_execute`,
  `publish_artifact`, `read_file`, `write_file`, `edit_file`, `bash`,
  `ask_user`, `finish`; the deeply frozen prompt/API prefix SHA-256 is
  `f8f94520d78221dcf36c184681faeb80c56414aa5d591088c384ea171e235e88`.
  A relative-import closure from `src/cli/runTask.ts` reaches 54 production
  modules (25 under `src/v3/`) and no retired scheduler/store/browser-action
  module. A source audit found no task-name or task-text dispatch branch.
- Final physical-line counts use the original audit convention: production
  `src` is 31,680 lines across 111 files; every tracked test is 34,760 lines
  across 131 files. Against the temporary Step 6 coexistence peak, production
  is down 19,529 lines/56 files (38.1%), tests are down 17,125 lines/44 files
  (33.0%), and combined code is down 36,654 lines (35.6%). Against the pre-v3
  baseline, the completed system is 1,877 production lines and 1,698 test
  lines smaller (3,575 combined, 5.1%) despite retaining the new v3 features.
  Tracked files fell from 579 at coexistence to 477. The branch-wide textual
  diff is 29 commits / 297 files / +41,221/-42,932 lines; that rewrite-heavy
  number is reported separately and is not presented as structural SLOC.
- No local blocker remains. Deliberately unrun external measurements are the
  live/billable Browserbase smoke (including real Context, upload/download,
  target-site IP/fingerprint behavior), first-use attachment to the user's
  daily Chrome, and an eval re-baseline against changing live sites. The
  run-local module loader retains the documented narrow same-user TOCTOU and
  normal nested-import resolution; `bash` and model-authored browser programs
  remain explicitly non-sandboxed OS-user capabilities.

### 2026-08-15 — Step 7 direct-evidence re-audit closed

- Re-read the design against the completed tree and reverified the official
  `browser-use/browser-harness` commit
  `6a80dbbce51e8c1776af061282546627f007be4e`. The design now links its exact
  `run.py`, daemon, helper, IPC, and telemetry sources and distinguishes the
  borrowed programmable-CDP idea from Sherlock's bounded child lifecycle,
  provider-secret boundary, durable ownership, artifacts, verifier, TUI, and
  eval systems.
- Replaced the remaining inferred acceptance claims with these direct current
  journeys:

  | Journey | Direct evidence |
  | --- | --- |
  | Exact public CSV | `src/cli/runTask.test.ts` — public initializer/worker/verifier run, exact columns/row count, hashes, secret sweep, terminal projections, and owned-page cleanup |
  | Screenshot/download and TUI-to-grader | `tests/tui/tui-to-grader.test.ts` — ordered UI events, exact capture bytes/provenance/roles, manifest selection, and a grader that still succeeds after transcript deletion |
  | Multi-page synthesis | `src/v3/tools/multiPageSynthesis.integration.test.ts` — run-local helper, two owned pages, one published document, filtered target inventory, and preserved ambient page |
  | Human handoff | `tests/tui/run-session.test.ts` — announced/answered `ask_user`, cancellation while paused, and headless fail-closed continuation |
  | Cancellation containment | `tests/tui/cancellation-acceptance.test.ts` — real browser/Bash child groups and descendants die, partial workspace is reconciled, locks/pages close, and the next task succeeds in the same browser session |
  | Crash/resume boundaries | `src/v3/run/coordinator.crash.test.ts` — real second-process kills at model, pre-tool, uncertain-tool, post-tool, checking/correction, and verifier-accounting boundaries |
  | Provider parity | `src/browser/providerContract.integration.test.ts` — managed local, attached local, and Browserbase fake share command/upload/download/redaction/cleanup/idempotence behavior |
  | Ambient target authority | `src/browser/browserTargetAuthority.integration.test.ts` — attached Chrome exposes only owned targets; known ambient IDs cannot be inspected, activated, attached, or closed; all `Browser.*` commands fail closed |
  | Static prefix | `src/v3/systemPrompt.test.ts` and `src/v3/tools/index.test.ts` — the exact frozen eight-tool prefix is invariant across tasks, providers, policy, and secret denylists |

- The re-audit found and fixed one genuine authority defect rather than
  declaring completion around it: a page-attached CDP session could enumerate
  or mutate pre-existing attached-browser targets. The private command-session
  policy now filters `Target.getTargets`, authorizes info/activate/close only
  for current run-owned targets, routes creation through durable ownership,
  rejects every other `Target.*`, and rejects the browser-global `Browser.*`
  domain. A merged real-browser/provider gate passes 8 files / 82 tests.
- Closed two smaller helper-boundary gaps: workspace module entry size and
  fresh child/module state now have direct regressions, and deliberate direct
  writes to Node IPC are proved to fail closed when malformed or oversized.
  The IPC ceiling is honestly documented as application-level after Node
  delivery, not as hostile-process memory isolation.
- Final gates: `npm run typecheck -- --pretty false` passes;
  `git diff --check` passes; and the complete hermetic suite passes 136/136
  files and 1,477/1,477 tests in 82.67 seconds. The first complete pass exposed
  one test-only Bash cancellation race: a fixed sleep could abort before the
  asserted readiness file existed under suite load. The test now waits for
  that exact condition; its focused 13/13 gate and the subsequent full suite
  pass.
- The prompt/tool-prefix SHA-256 remains
  `f8f94520d78221dcf36c184681faeb80c56414aa5d591088c384ea171e235e88`.
  The model-facing order remains exactly `browser_execute`,
  `publish_artifact`, `read_file`, `write_file`, `edit_file`, `bash`,
  `ask_user`, `finish`. The target-authority fix changes neither prompt nor
  schema.
- Final raw-line accounting is intentionally two-view. Under the original
  TypeScript/TSX audit convention, production `src` is 31,843 lines across 111
  files and every tracked test is 37,103 lines across 136 files. The three
  shipping `.mjs` browser-child/helper files add 982 lines, so total shipping
  source is 32,825 lines across 114 files. The tree has 483 tracked files.
  Against the temporary coexistence peak, like-for-like TypeScript production
  is down 19,366 lines/56 files (37.8%), tests are down 14,782 lines/39 files
  (28.5%), and combined counted code is down 34,148 lines (33.1%). Against the
  pre-v3 baseline, TypeScript production is 1,714 lines smaller while tests are
  645 lines larger; including the new `.mjs` runtime, total production plus
  tests is essentially flat (87 lines smaller) while direct acceptance grows
  materially. That is the honest trade: the simplification is structural —
  one runtime and deleted legacy mechanisms — not formatting/comment gaming,
  and the final safety audit deliberately added code and tests.
- The branch from `bbe94ac` is 38 commits / 303 files /
  +44,018/-42,930 textual lines. That rewrite-heavy diff is not presented as
  SLOC reduction. No live/billable Browserbase smoke, daily-browser first-use
  attachment, or live-site eval re-baseline ran without user authorization;
  those remain external measurements rather than local implementation
  blockers.

### 2026-08-16 — post-eval publication and finish ergonomics complete

- A user-authorized live Hacker News trial passed all 6/6 grader assertions
  and matched 5/5 fresh titles, but took 14 worker turns. The browser extraction
  itself took 174 ms; most avoidable work came from four incorrect
  `publish_artifact.source_path` spellings, a broad Bash search for the file,
  and a rejected `finish` that repeated an evidence-only path as a requested
  output.
- [x] Make workspace publication paths use one explicit run-relative spelling
  beginning with `scratch/workspace/`, return that canonical path as structured
  `write_file` data, and make invalid-path feedback directly actionable.
- [x] Clarify that inline `kind: text` is the direct path for small final
  CSV/JSON/Markdown/text outputs; retain `kind: file` for an existing workspace
  file without adding another worker-visible tool.
- [x] Remove the redundant requested-output path list from `finish`. Keep the
  explicit exclusive control call, but derive its artifact facts from the
  authoritative manifest during deterministic checks and persist those facts
  for verification/recovery.
- [x] Update the binding design, static tool-schema snapshots, checkpoint and
  coordinator fixtures, and focused integration coverage. Prove the compact
  scripted journey `browser_execute -> publish_artifact -> finish`, then run
  typecheck, affected tests, full hermetic tests, and diff checks.
- Focused verification after the path/result slice: `npm test -- --run
  src/v3/tools/fileTools.test.ts src/v3/tools/publishArtifact.test.ts
  src/v3/tools/toolSurface.integration.test.ts` passes 3 files / 29 tests;
  `npm run typecheck -- --pretty false` passes.
- The public fixture-backed run in `src/cli/runTask.test.ts` now pins the compact
  browser journey at exactly three worker turns. Requested-output paths live
  only in manifest facts; verifier context labels them as code-derived rather
  than worker claims. Checkpoint v3 retains read compatibility by normalizing
  the retired field at its schema boundary, with active/terminal compatibility
  and malformed-current-claim regressions.
- Final gates: the affected contract/public-run group passes 7 files / 148
  tests; the complete hermetic suite passes 136 files / 1,479 tests in 88.41s;
  `npm run typecheck -- --pretty false` and `git diff --check` pass. The static
  eight-tool order is unchanged. The one intentional static prompt/schema
  revision has SHA-256
  `a8db70417eccf525ef471a5c3f20b67004ee9fe8a45f792f24ddf24d484e4b17`.

### 2026-08-16 — YC eval token-cap retry

- A user-authorized k=1 YC W24 outreach run reached turn 16 while still
  researching founders and stopped at the 250,000 aggregate model-token
  ceiling before publishing or finishing.
- [x] Lift only the default aggregate model-token ceiling; retain the worker
  turn, tool-call, result-byte, request-context, correction, and wall-time
  limits unchanged.
- [x] Rerun `yc_w24_outreach` at k=1. The retry passed the former token
  boundary, consumed 24 worker turns and roughly 433k aggregate model tokens,
  then stopped at the unchanged `maxWorkerTurns` limit before publishing or
  finishing. It graded 1/8 (manifest integrity only) in 173.2 seconds; report:
  `evals/experiments/2026-08-16_03-11-17am_eval-yc-w24-outreach_0fa1cc.json`.

## Rules for coordinators and subagents

- Read this file and the design before taking a task.
- Inspect `git status` and the relevant code; do not trust this log alone.
- Work on one checked step or a clearly named sub-item. Do not start parallel
  edits in shared composition files.
- Do not edit `docs/architecture-whiteboard.html` unless explicitly asked.
- Do not run paid/live eval batches without user direction.
- Never read or print `.env` values.
- Use `apply_patch` for edits and report every touched file.
- Run the smallest relevant gate before handing work back. Workers do not
  commit; the coordinator verifies and commits scoped changes.
- Update this file after a verified slice, including exact commands/results
  and any new gap or decision.
