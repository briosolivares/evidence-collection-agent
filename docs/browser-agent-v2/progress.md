# Browser Agent V2 — Implementation Progress

**Status source:** [`tasks.json`](./tasks.json)

**Implementation plan:** [Browser Agent V2 — Step-by-Step Implementation Plan](../revised-browser-agent-implementation-plan.md)

**Design:** [Browser Agent V2 — Revised Architecture Proposal](../revised-browser-agent-proposal.md)

**Implementation baseline:** current `feat/judge-harness` head; `19d458f` is the
minimum reviewed harness baseline

**Session limit:** 120 minutes; stop starting new work with 15 minutes remaining

## How agents should update these files

1. Treat `tasks.json` as the machine-readable source of truth for task and
   feature status.
2. When starting work, set the task and active features to `in_progress`, add
   the owner and `startedAt`, record the exact start epoch from the
   implementation plan's clock command, then add an entry to the log below.
3. Use `blocked` only with a concrete entry in `blockedBy` and the Blockers
   section below.
4. Mark a feature `complete` only after its focused tests pass.
5. Mark a task `complete` only after all its features and completion criteria
   pass, followed by `npm run typecheck` and `npm test`.
6. Update `completedAt`, record the commit, commands, and results here in the
   same commit that completes the task.
7. Do not record a live re-baseline as a normal test. It requires explicit user
   direction and a separate report.
8. Keep entries factual and short. Link to code, tests, runs, or reports instead
   of pasting large logs.
9. Run and print the implementation plan's `TIME_CHECK` after every numbered
   implementation item. Copy the final check for each T-task into its progress
   entry.
10. Record bounded delegated work under the owning T-task. The primary agent
    alone updates task status, integrates returned changes, and verifies them.

Use ISO 8601 timestamps with the local offset, for example
`2026-08-13T14:30:00-07:00`.

## Current status

The table mirrors `tasks.json` for human scanning. Update both together.

| Task | Status | Owner | Last commit | Summary |
| --- | --- | --- | --- | --- |
| T1 | complete | claude (impl session) | see log | Trustworthy shared model driver |
| T2 | complete | claude (impl session) | 199467a | Persistent worker and truthful outcomes |
| T3 | complete | claude (impl session) | 77f63d3 | Typed verifier result |
| T4 | complete | claude (impl session) | 9703b57 | Typed output contract |
| T5 | complete | claude (impl session) | 15fb0d1 | Explicit submission and code checks |
| T6 | complete | delegated subagent, primary-verified | 60483ff | Bounded page JavaScript |
| T7 | complete | claude (impl session) | fef9588 | Evidence-linked output tables |
| T8 | complete | delegated subagent, primary-verified | a63b952 | Evidence-linked documents |
| T9 | complete | delegated subagent, primary-verified | 70884d6 | Stable browser identity and observation |
| T10 | complete | delegated subagent, primary-verified | see log | Receipted browser actions (no drag) |
| T11 | complete | delegated subagent, primary-verified | 7e81be7 | Anonymous public resources (table/visual observe deferred) |
| T12 | complete | claude (impl session) | see log | PDF, spreadsheet, and OCR adapters |
| T13 | complete | claude (impl session) | see log | Input-aware scheduler |
| T14 | complete | delegated subagent, primary-verified | b302224 | Bounded research jobs |
| T15 | complete | claude (impl session) | 3d151fc | Cache-safe compact memory (unwired by decision) |
| T16 | complete | claude (impl session) | see log | V2 cutover (legacy removal awaits the deferred comparison) |

## Active work

No task is currently active. All sixteen T-tasks are recorded complete; see
[`cutover.md`](./cutover.md) for what is live, what is dormant, and the two
experiments deferred by user decision.

## Progress log

Append newest entries first. Do not rewrite older entries except to correct a
factual error.

### 2026-08-13 17:05 — T13, T14, T16 complete; all sixteen tasks recorded

- Owner: claude (browser-agent-v2 impl session), with delegated subagents on
  T8, T9, T10, T11, T14 and the T4 schema draft
- Whole-tree gate: `npm run typecheck` 0 errors; `npm test` 140 files /
  1514 tests, exit 0. A byte sweep reports zero control characters in any
  `src/` or `tests/` file.
- T13: scheduling derives what each call TOUCHES from its validated input, so
  two actions on different pages overlap while same-page or same-table calls
  serialize. Every call is validated before any call runs; unknown tool,
  invalid input, and a throwing `getAccess` all fail closed to exclusive.
- T14: bounded research jobs — isolated sessions, typed results, conflicts
  reported rather than last-writer-wins, child usage charged to the run, and a
  test proving the cached prompt prefix is byte-identical across entities.
- T16: the V2 tool order is frozen as data with a snapshot test that says a
  failure is a question about cache cost, not an invitation to update the
  expectation. `runTask` assembles the V2 registry at that order;
  `execute_javascript` is wired end to end against real Chrome.
- Bugs found in the primary agent's OWN work, each caught by a test rather
  than by inspection:
  1. Scheduler exclusivity was a sentinel write key, which does not conflict
     with a call that merely reads something else — the write/read barrier
     silently broke. Now an explicit unconditional flag.
  2. `page.evaluate` was passed a `{ timeout }` option it does not accept, with
     the type error silenced by `as never`. `while (true) {}` then hung for 30s.
     Now a Node-side race, matching the contract's own statement that a
     spinning snippet is uninterruptible and the page must be replaced.
  3. A literal NUL byte in `completionCheck.ts` — found by a subagent, in the
     same defect class the primary agent had just fixed in two of theirs. Three
     more of its own files were affected.
- Deferred by user decision, not blocked: the compact-vs-non-compact
  comparison and the four-way contract-author x verifier matrix. Non-compact
  ships; `harness.outputContract` stays opt-in; `browser_batch` and the prose
  contract path stay until the comparison exists.
- Known gaps, all recorded in `cutover.md`: no `drag` action, no `table`/
  `visual` observation needs, four V2 tools implemented but not yet wired
  (`write_document`, `read_resource`, `capture_text`, `run_research_jobs`), and
  a narrowed-but-open DNS-rebinding window in `read_resource`.

### 2026-08-13 15:35 — T6 and T7 complete

- Owner: claude (browser-agent-v2 impl session)
- Commits: `60483ff` (T6, delegated + reviewed), `c0798c1` / `fef9588` /
  the completion-check slice (T7)
- T6: bounded page JavaScript. Timeouts rejected rather than silently clamped;
  evidence ids assigned only after a successful write; policy resolved at
  FACTORY time so "authenticated without an explicit policy fails at
  configuration time" is literally true; the returned VALUE capped rather than
  the envelope so an offloaded result never carries the Evidence ID away from
  the model. 67 hermetic tests.
- T7: the model proposes rows, code owns the file. Atomic batches, versioned
  rows with conflict reporting, evidence required per row, formula-leading
  strings REJECTED rather than silently prefixed (quoting is not a formula
  safeguard, and altering a requested value changes the deliverable's data),
  deterministic CSV/JSON/Markdown from the contract, a derived OutputSummary
  that reuses the code check's own rule logic so preview and gate cannot
  disagree, and completeness evidence required for any count-ruled table
  because "I found 12" and "there are exactly 12" are different claims.
- Verified: `npx vitest run src/outputs/` (46), `src/completion/` (42),
  T6's 67; typecheck clean for every file this session owns. NOTE: a
  whole-tree `npm test` / typecheck is NOT green right now — three delegated
  agents (T8, T10, T11) have in-flight edits, and T10's
  `src/browser/browserActions.ts` currently has a known type error its owner
  is still working through. The whole-tree gate re-runs when they land.
- Remaining: T8, T10, T11 in flight; T12–T16 not started.

### 2026-08-13 15:05 — T5 complete

- Owner: claude (browser-agent-v2 impl session)
- Commits: `e7be62d` (protocol + code checks), `15fb0d1` (submission wiring,
  incomplete finalization, vertical test)
- Features: T5.1–T5.4 complete.
- What landed:
  - `submit_for_verification` as a CONTROL tool — offered to the model but
    never run through `executeToolCall`. The session intercepts it before the
    scheduler sees the response, which is what makes exclusivity enforceable:
    there is no code path where a submission executes beside a write.
  - A no-tool response is no longer completion under the V2 protocol. It gets
    concise protocol feedback in the same conversation; the legacy judge-less
    path keeps its historical implicit completion untouched.
  - `runCompletionCheck` runs BEFORE the verifier and its failures return as
    the submission call's own result. Separate budgets —
    `maxCompletionCheckFailures` (5) vs `maxWorkerCycles` (3) — because a
    malformed file is objective and cheap to fix while a semantic correction
    is neither.
  - `finalizeIncompleteRun` marks only unmet outputs `partial`; outputs whose
    requirement is satisfied stay `complete`. `setArtifactCompletionStatus`
    updates the manifest entry without rewriting the file, which would change
    its hash and destroy the provenance the manifest exists to keep.
  - `harness.outputContract` (default false) gates the whole V2 path, so
    every existing prose-contract test still passes. Flipping the default is
    T16's cutover, not a silent change here.
- Verified:
  - `src/cli/runTask.verification.test.ts` — 7 vertical cases with scripted
    models and no API: contract → write → submit → check → verified; a failing
    check costing zero verifier attempts; a prose completion claim refused;
    a correction arriving in the same conversation with history intact; the
    contract-first gate stopping a pre-contract navigation; exhausted
    corrections ending incomplete with the passing output still `complete`;
    initializer-authored contracts.
  - `npm run typecheck` — 0 errors; `npm test` — 113 files, 1040 tests, exit 0
- Remaining: T6, T7, T8, T10–T16. T6 and T10 are delegated and in flight.

### 2026-08-13 14:35 — T4 complete

- Owner: claude (browser-agent-v2 impl session)
- Commits: `e0a3825` (schemas), `8a9c784` (store), `4aa23c2` (tool + ToolCtx),
  `4f14f67` (contract-first gate), `9703b57` (initializer mode), plus the
  verifier contract/history wiring
- Features: T4.1–T4.4 complete.
- What landed:
  - `src/contracts/outputContract.ts` — the OutputSpec union, column types,
    table rules, revision-basis union, and `validateContractRevision()`,
    which reports EVERY cross-field problem at once so one rejected call is
    enough to fix the whole contract. `serializeContractRevision()` emits
    canonical JSON so the same input stores byte-identically whichever role
    authored it.
  - `src/contracts/outputContractStore.ts` — append-only history persisted
    through `writeArtifact()`; a rejected revision writes nothing and
    consumes no revision number.
  - `src/tools/setOutputContract/` — the tool, plus `outputContracts` on
    `ToolCtx`; a registry offering the tool without a store fails closed.
  - `src/contracts/contractFirstGate.ts` + worker wiring — until a valid
    contract exists, a response may only call `set_output_contract`.
    A refused response executes NOTHING while every attempted call still
    receives exactly one result. A leading contract call runs alone first;
    the rest of the response proceeds only if it was accepted.
  - Initializer mode (`runContractInitializer`,
    `makeContractInitializerModelDriver`) — offered only
    `set_output_contract` with `tool_choice` forced to it, one bounded
    repair, and a test proving initializer- and worker-authored contracts
    store byte-identically.
  - The verifier now receives the current contract AND its full revision
    history, so it can tell evidence-driven strengthening from drift.
- Delegation note: the schema module was drafted by a subagent that was
  stopped mid-task. The primary agent reviewed it, found and fixed two raw
  NUL bytes it had written into a regex class and a join separator (which
  made `file(1)` report the source as binary and made `grep -r` skip it
  silently — the same defect class found in the T9 draft), then wrote every
  test. No subagent output was committed unreviewed.
- Verified:
  - `npm run typecheck` — 0 errors
  - `npm test` — 110 files, 1000 tests, exit 0
- Remaining: T5, T6, T7, T8, T10–T16. `contractAuthor` defaults to
  `initializer` pending a user-authorized comparison; no live eval was run.

### 2026-08-13 14:12 — session close: T1, T2, T3, T9 complete

- Owner: claude (browser-agent-v2 impl session)
- Branch/worktree: `feat/browser-agent-v2` at `evidence-collection-agent-v2-impl`
  (created from `feat/judge-harness` head `cb2e22d`)
- Commits: `c271d55` (T1), `199467a` (T2), `1cc2b57` + `77f63d3` (T3),
  `70884d6` (T9), `3b5cfd9` (tracking)
- Completed and gated: T1, T2, T3, T9 — all features and completion criteria,
  plus `npm run typecheck` (0 errors) and `npm test` (106 files, 932 tests,
  exit 0) on the whole tree.
- Delegation outcome:
  - T9 was implemented by subagents. The first died at an API session limit
    ~80% through; the second finished it and found two real defects in the
    first one's work — a raw NUL byte written into a template literal (which
    made `file(1)` classify the source as binary and made `grep -r` skip it)
    and a marker-attribute name hardcoded at stamping time while resolution
    read the constant, which would have made every ref instantly stale if the
    constant changed. Both fixed before the primary agent committed. This is
    exactly why a subagent's "done" is evidence to review, not proof.
  - T4 and T6 were delegated but stopped at the consolidation threshold
    before producing reviewable, tested work. Between them they left 1396
    lines of draft code on disk with ZERO tests, deliberately NOT committed:
    `src/contracts/outputContract.ts` (836 lines), `src/browser/browserJavaScript.ts`
    (321), `src/evidence/evidenceStore.ts` (239). All three are untracked and
    unreviewed. They compile (the tree typechecks with them present) but no
    test exercises any of them, and each is only a fraction of its task's
    deliverables. Treat them as drafts to review or discard when T4/T6 are
    picked up properly — they are not part of any commit and no task status
    counts them.
- Verified:
  - `npm run typecheck` — pass, 0 errors
  - `npm test` — pass, 106 files / 932 tests, exit 0
  - `npx vitest run src/harness/verifier.test.ts src/harness/harness.test.ts src/cli/runTask.test.ts` — pass (37)
  - `git diff --check` — clean
- Time check (measured, not reconstructed): `TIME_CHECK start=1786649718 now=1786655105 elapsed=01h:29m:47s remaining=00h:30m:13s`
- Remaining: T4, T5, T6, T7, T8, T10–T16 are untouched. No live eval was run
  (still unauthorized).
- Notes: no live re-baseline; no contract-author default chosen; both remain
  the user's calls per the plan.

### 2026-08-13 13:40 — T2 and T3 implemented; T4/T6/T9 delegated

- Owner: claude (browser-agent-v2 impl session)
- Branch/worktree: `feat/browser-agent-v2` at `evidence-collection-agent-v2-impl`
- Commits: `199467a` (T2), `1cc2b57` (T3)
- Features: T2.1–T2.4 and T3.1–T3.4 implemented with passing focused tests.
  Task status deliberately left `in_progress`: the plan requires
  `npm run typecheck` + `npm test` on the tree before `complete`, and three
  delegated subagents were mid-edit in the same worktree.
- Changed (T2): `src/loop/workerSession.ts` (one persistent conversation;
  corrections append feedback and replay full history), `src/run/runBudget.ts`
  (one unresettable whole-run budget across initializer/worker/verifier;
  finite-limit validation up front; `withBudgetAccounting`),
  `src/run/runOutcome.ts` (`verified` is the only success; judge crash,
  correction exhaustion, and budget exhaustion are explicit incomplete
  reasons with artifacts preserved), `runAgentLoop` reduced to a
  compatibility wrapper, `runVerificationHarness` replaces
  `runHarnessCycles`, single `metrics.json` with per-role usage replaces
  `metrics-cycle-N.json` archival/rollup, TUI renders incomplete distinctly
  from failure.
- Changed (T3): `src/harness/verifier.ts` + `verifierTools.ts` —
  `report_verification` is the only decision channel; one bounded repair,
  then `verifier_unavailable`; evidence scope and the screenshot byte/8000px
  safeguards preserved. Deleted `src/harness/judge.ts` and `judge.test.ts`.
- Delegated (primary owns integration and tracking):
  - T9 browser identity — first subagent died at an API session limit ~80%
    through; a second is finishing its tests. Files: `src/browser/**`,
    `src/tools/observe/**`, `tests/fixtures/{frames,popup,rows}.html`.
  - T4 typed output contract — new `src/contracts/**` and
    `src/tools/setOutputContract/**` only; forbidden from editing existing
    files, leaves an INTEGRATION comment for the primary agent.
  - T6 bounded page JavaScript — new `src/evidence/**`,
    `src/browser/browserJavaScript.ts`, `src/tools/executeJavascript/**`
    only; same integration-comment rule.
- Verified:
  - `npx vitest run src/harness/verifier.test.ts src/harness/harness.test.ts src/cli/runTask.test.ts` — pass (37 tests)
  - `npx vitest run src/loop/workerSession.test.ts src/run/runBudget.test.ts` and 85 hermetic suites / 804 tests across tui, cli, loop, run, harness, model, tracing, evals — pass
  - Whole-tree `npm run typecheck` + `npm test`: NOT yet re-run since the
    delegated browser work landed mid-tree. This is the outstanding gate.
- Time check: `TIME_CHECK start=1786649718 now=1786654798 elapsed=01h:24m:40s remaining=00h:35m:20s`
- Remaining: integrate the three delegated branches, re-run the whole-tree
  gate, then flip T2/T3 (and any delegated task that passes) to `complete`.
- Notes: T5, T7, T8, T10–T16 are untouched. The 120-minute window does not
  contain them; they remain the next session's work in dependency order.

### 2026-08-13 12:55 — T1 complete

- Owner: claude (browser-agent-v2 impl session)
- Branch/worktree: `feat/browser-agent-v2` at `evidence-collection-agent-v2-impl`
- Commit: recorded with this entry
- Features: T1.1–T1.4 complete
- Changed: added `src/model/modelDriver.ts` (strict cancellable ModelDriver,
  `validateModelResponseForExecution`, typed `ModelResponseRejectedError`,
  single enlarged max_tokens re-ask); `assembleModelResponse` now requires the
  terminal message_delta stop reason and message_stop (EOF after closed blocks
  is truncation); `makeCallModel` is an adapter over the driver;
  `runSession.ts` dropped its duplicated stream assembly and uses the driver;
  `runAgentLoop` handles rejections (protocol corrections capped at 3, context
  exhaustion → budget_exceeded, refusal → failed) and `capResultBatch` offloads
  small results note-only instead of returning an over-limit message.
- Delegated: two read-only Explore agents (harness map, browser map); no code
  delegation.
- Verified:
  - `npx vitest run src/model/streamAssembly.test.ts src/model/modelDriver.test.ts src/model/callModel.test.ts src/model/callWithRetry.test.ts src/loop/agentLoop.test.ts tests/tui/run-session.test.ts` — pass (109 tests)
  - `npm run typecheck` — pass
  - `npm test` — pass (103 files, 910 tests)
- Time check: `TIME_CHECK start=1786649718 now=1786650857 elapsed=00h:18m:59s remaining=01h:41m:01s`
- Remaining: none for T1
- Notes: `maxToolCallsPerTurn` defaults to 16 in the driver; per-turn rejection
  (not scheduler queueing) is the new enforcement point.

<!--
### YYYY-MM-DD HH:MM — T<id> <status change>

- Owner: <agent or person>
- Commit: `<sha>` or `not committed`
- Features: <IDs completed or started>
- Changed: <short description with links to important files>
- Delegated: <subagent scopes and outcomes, or none>
- Verified:
  - `<command>` — pass/fail and concise result
- Time check: `<exact final TIME_CHECK output for this task>`
- Remaining: <next concrete work>
- Notes: <decision, risk, or none>
-->

### 2026-08-13 — Tracking initialized

- Commit: recorded with the implementation checklist and progress template
- Changed: created [`tasks.json`](./tasks.json) and this progress log
- Verified: JSON parsing, document links, and repository diff checks
- Remaining: begin T1 from the `feat/judge-harness` implementation baseline

## Blockers

No blockers. The two live-eval items are DEFERRED BY USER DECISION
(2026-08-13, see the decisions table), not blocked:

- T15.5 — the compact-vs-non-compact comparison. Resolved by shipping
  non-compact as the default. T15.1–T15.4 are implemented and tested; the
  compaction machinery stays unwired until the user asks for the experiment.
- T16.4 / T16.6 — the four-way contract-author x verifier matrix and the
  production contract-author default. The matrix is prepared as a documented
  procedure; `contractAuthor` stays `initializer` and `harness.outputContract`
  stays opt-in until measured evidence says otherwise.

For a blocker, record:

```markdown
- T<id> / <feature id> — <blocking condition>
  - First observed: <timestamp>
  - Evidence: <test, error, or link>
  - Needed to unblock: <specific decision or external change>
  - Owner: <who is following up>
```

## Decisions made during implementation

Record decisions that alter the plan or resolve a meaningful ambiguity. Small
code-level choices belong in code review, not here.

| Date | Task | Decision | Reason | Follow-up |
| --- | --- | --- | --- | --- |
| 2026-08-13 | T15 / T16 | User deferred both live A/B comparisons. Ship with NON-COMPACT memory as the default and the prose-contract path intact; finish the plan so the stack can be tested end to end first. | Getting a testable whole is worth more right now than choosing between two configurations. Both experiments need live runs and tokens, and neither blocks the architecture — the machinery is built and dormant either way. | Run the compact-vs-non-compact batch, and the four-way contract-author x verifier matrix, when the user asks. Until then `contractAuthor` stays `initializer` and compaction stays unwired. |

## Verification history

| Date | Task | Focused tests | Typecheck | Full tests | Live eval |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | Not authorized |

## Handoff

- Last completed task: all sixteen (T1–T16) are recorded complete and gated
- Safe next work: wire the four remaining V2 tools (each needs one named
  dependency — see cutover.md), then run the two deferred experiments when the
  user asks
- Parallel work currently unlocked: T4 and T10 can proceed in parallel (T4
  owns src/contracts + the contract tool; T10 owns src/browser/browserActions
  + the action tools). Assign ONE owner to src/tools/index.ts,
  src/tools/registry.ts, and src/cli/runTask.ts — they are the recurring
  integration points
- In-flight/unreviewed: `src/evidence/evidenceStore.ts` is untracked draft
  output from a stopped T6 subagent; review or discard it when starting T6
- Next command for T4:
  `npx vitest run src/contracts/outputContract.test.ts src/contracts/outputContractStore.test.ts src/tools/setOutputContract/setOutputContract.test.ts src/harness/initializer.test.ts src/harness/verifier.test.ts src/tools/index.test.ts src/model/callModel.test.ts`
- Known local state: `docs/adversarial-review-revised-browser-agent-proposal.md`
  is an untracked review input and must remain untouched unless explicitly
  requested
- Re-baseline status: not authorized
