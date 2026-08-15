# Sherlock v3 implementation plan and progress log

**Status:** active

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

The implementation strategy is a parallel v3 path, not an in-place rewrite of
the legacy harness. New v3 modules may reuse stable seams, but they must not
inherit initializer/contract/table/evidence/scheduler complexity merely to
avoid writing a smaller coherent replacement. Cutover happens only after the
new path passes its gates; legacy production wiring is removed afterward.

## Binding decisions

These decisions are made for the current implementation. Change one only by
updating the design and this plan in the same commit.

1. **One persistent worker conversation.** The worker keeps its full useful
   history across verifier corrections.
2. **Sequential tools.** Tool calls execute in response order. There is no
   access-key scheduler or abandoned-resource ledger in the v3 loop.
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
- [ ] fixture-backed current application smoke path

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

- [ ] Create a new v3 system prompt whose static prefix and tool order are
  deterministic.
- [ ] Implement the single-conversation sequential loop over the existing
  strict streaming model driver.
- [ ] Execute multiple tool calls in response order and return results in the
  same order.
- [ ] Preserve result offloading, stale browser-result collapse, protocol
  correction limits, context/turn/wall/token budgets, transcript events, and
  metrics using smaller v3-owned state.
- [ ] Treat zero-tool responses as working and accept completion only through
  the exclusive `finish` call.
- [ ] Add snapshot/restore of v3 conversation state.

**Gate:** scripted model tests prove ordering, malformed-call recovery,
offloading, budget termination, explicit finish, cancellation, and byte-stable
prompt/tool definitions.

### Step 4 — finish checks, verifier loop, and durable coordinator

- [ ] Run the contract initializer once; store one immutable typed contract in
  harness-private state and show it to the worker as per-run guidance.
- [ ] Implement `finish` input (`summary`, published paths, unresolved limits)
  and interception in the v3 loop.
- [ ] Adapt deterministic completion checks to generic published artifacts:
  exact filenames, exact CSV columns, row/count rules, non-placeholder
  content, requested screenshots/downloads, hashes, and roles.
- [ ] Invoke the existing fresh-context verifier only after code checks pass;
  append check/verifier feedback to the same worker conversation.
- [ ] Write a compact v3 checkpoint at turn/tool/verifying/terminal boundaries
  under `harness/checkpoint.json`, atomically and with a run lock.
- [ ] Make manifest replacement atomic and durable (temporary file, fsync,
  rename, parent-directory fsync) so a killed writer cannot leave truncated
  provenance.
- [ ] Implement resume, including explicit uncertain-effect recovery instead
  of blind tool replay.
- [ ] Finalize transcript, metrics, manifest, tracing, and owned browser pages
  on success, incomplete exit, cancellation, and crash.

**Gate:** scripted end-to-end tests cover verified, deterministic rejection and
repair, verifier correction and repair, budget exhaustion, crash/resume at each
boundary, and cleanup on every terminal path.

### Step 5 — TUI and eval cutover

- [ ] Preserve `runTask`'s public configuration/result seam or provide a thin
  compatibility adapter.
- [ ] Make v3 the default for `sherlock`, `npm run agent`, demos that represent
  production, CLI evals, and TUI evals.
- [ ] Preserve ordered progress, tool pending/result, question dialog,
  artifact-published, cancellation, browser death/relaunch, and terminal
  events.
- [ ] Preserve headless parallel and headed serial eval lanes, login preflight,
  provider selection, grader inputs, report schema, and regrade behavior.
- [ ] Add/adjust bridge and runner tests without pinning v3 private internals.

**Gate:** TUI and eval integration suites pass unchanged at their public
boundaries, and a fixture-backed `sherlock` run renders/publishes artifacts.

### Step 6 — retire legacy production mechanisms

- [ ] Prove no production import reaches the legacy scheduler, mutable contract
  tool, typed row/evidence stores, document renderer tools, or old checkpoint
  replay path.
- [ ] Remove unreachable production modules, demos, and tests that exist only
  for the retired path; keep reusable parsers/checks and historical reports.
- [ ] Consolidate current documentation and update `AGENTS.md`, README, and the
  architecture summary so they describe v3 rather than the retired protocol.
- [ ] Keep removals separate from v3 behavior changes and report structural
  versus cosmetic line reduction honestly.

**Gate:** semantic import search shows one production run path; no active docs
or prompts name removed tools/protocols; focused and full tests pass.

### Step 7 — final acceptance and completion audit

- [ ] Run `npm run typecheck`.
- [ ] Run the complete hermetic `npm test` suite.
- [ ] Run fixture-backed acceptance journeys for table, screenshot/download,
  multi-page synthesis, human handoff, cancellation, and crash/resume.
- [ ] Run the Browserbase smoke only if credentials/approval are available and
  it is still necessary; record any unverified remote behavior explicitly.
- [ ] Run a secret sweep over representative run directories.
- [ ] Inspect final diff, production import graph, tool order/schema snapshot,
  manifest outputs, transcript, metrics, checkpoints, and owned tabs.
- [ ] Complete the requirement-to-evidence matrix in this file.
- [ ] Record final line/file/test deltas and residual risks.

**Gate:** every explicit objective and design requirement has direct current
evidence. Passing narrow tests alone is not completion.

## Requirement-to-evidence matrix

Populate evidence as steps land. `Pending` means the requirement is not yet
proved, even if supporting code already exists.

| Requirement | Authoritative evidence | Status |
| --- | --- | --- |
| Expanded v3 design | Design document reviewed against code | Complete |
| Durable step plan/progress | This file | Complete; maintained continuously |
| Browser-harness reference used | Pinned commit plus design adaptation table | Complete |
| Programmable `browser_execute` | Tool tests + fixture acceptance transcript | Complete for Step 1 |
| Editable run helpers and reviewed promotion | Run artifact/patch tests + docs | Pending |
| Compact v3 tool surface | Registry/schema snapshot | Pending |
| Sherlock TUI preserved | TUI integration suite + fixture smoke | Pending |
| Streaming main loop preserved | Model/loop tests + transcript | Pending |
| Evals/graders preserved | Eval runner/grader suite + boundary inspection | Pending |
| Durable run directory preserved | Manifest/checkpoint/resume tests + run inspection | Pending |
| Local + Browserbase seam preserved | Provider tests; live smoke if authorized | Provider-neutral command seam complete; cutover/live smoke pending |
| Accuracy checks preserved | Completion/verifier correction tests | Pending |
| Owned tabs always cleaned | Browser lifecycle tests on all terminal paths | Controller and verified/failed run paths complete; cancellation cutover pending |
| Secrets/CDP capability never leak | Secret sweep + child-env tests | Browser substrate complete; final whole-product sweep pending |
| No task-specific logic | Source/prompt/helper audit | Pending |
| Full implementation complete | Steps 0–7 and final audit | Pending |

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
