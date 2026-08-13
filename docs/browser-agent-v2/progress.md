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
| T4 | not_started | — | — | Typed output contract |
| T5 | not_started | — | — | Explicit submission and code checks |
| T6 | not_started | — | — | Bounded page JavaScript |
| T7 | not_started | — | — | Evidence-linked output tables |
| T8 | not_started | — | — | Evidence-linked documents |
| T9 | complete | delegated subagent, primary-verified | 70884d6 | Stable browser identity and observation |
| T10 | not_started | — | — | Receipted browser actions |
| T11 | not_started | — | — | Targeted observation and public resources |
| T12 | not_started | — | — | PDF, spreadsheet, and OCR adapters |
| T13 | not_started | — | — | Input-aware scheduler |
| T14 | not_started | — | — | Bounded research jobs |
| T15 | not_started | — | — | Cache-safe compact memory |
| T16 | not_started | — | — | V2 cutover |

## Active work

No task is currently active.

When work begins, replace the sentence above with one section per active task:

```markdown
### T<id> — <title>

- Owner: `<agent or person>`
- Branch/worktree: `<branch and path>`
- Started: `<ISO 8601 timestamp>`
- Start epoch: `<exact BROWSER_V2_START_EPOCH output>`
- Latest time check: `<exact TIME_CHECK output>`
- Current feature: `<Tn.m and short description>`
- Delegated work: `<subagent, bounded scope, owned paths, status, or none>`
- Next action: `<single concrete next action>`
- Expected handoff: `<what another agent can safely start afterward>`
```

## Progress log

Append newest entries first. Do not rewrite older entries except to correct a
factual error.

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

None.

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
| — | — | No implementation decisions yet | — | — |

## Verification history

| Date | Task | Focused tests | Typecheck | Full tests | Live eval |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | Not authorized |

## Handoff

- Last completed task: T1, T2, T3, T9 — all fully gated (typecheck 0 errors,
  full suite 106 files / 932 tests)
- Safe next task: T4 (unblocked by T3; sequential core). T10 is also unblocked
  now that T9 has landed, and T6 needs only T4's run policy
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
