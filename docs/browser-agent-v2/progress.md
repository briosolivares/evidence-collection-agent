# Browser Agent V2 — Implementation Progress

**Status source:** [`tasks.json`](./tasks.json)

**Implementation plan:** [Browser Agent V2 — Step-by-Step Implementation Plan](../revised-browser-agent-implementation-plan.md)

**Design:** [Browser Agent V2 — Revised Architecture Proposal](../revised-browser-agent-proposal.md)

**Implementation baseline:** `feat/judge-harness` at `19d458f`

## How agents should update these files

1. Treat `tasks.json` as the machine-readable source of truth for task and
   feature status.
2. When starting work, set the task and active features to `in_progress`, add
   the owner and `startedAt`, then add an entry to the log below.
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

Use ISO 8601 timestamps with the local offset, for example
`2026-08-13T14:30:00-07:00`.

## Current status

The table mirrors `tasks.json` for human scanning. Update both together.

| Task | Status | Owner | Last commit | Summary |
| --- | --- | --- | --- | --- |
| T1 | not_started | — | — | Trustworthy shared model driver |
| T2 | not_started | — | — | Persistent worker and truthful outcomes |
| T3 | not_started | — | — | Typed verifier result |
| T4 | not_started | — | — | Typed output contract |
| T5 | not_started | — | — | Explicit submission and code checks |
| T6 | not_started | — | — | Bounded page JavaScript |
| T7 | not_started | — | — | Evidence-linked output tables |
| T8 | not_started | — | — | Evidence-linked documents |
| T9 | not_started | — | — | Stable browser identity and observation |
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
- Current feature: `<Tn.m and short description>`
- Next action: `<single concrete next action>`
- Expected handoff: `<what another agent can safely start afterward>`
```

## Progress log

Append newest entries first. Do not rewrite older entries except to correct a
factual error.

<!--
### YYYY-MM-DD HH:MM — T<id> <status change>

- Owner: <agent or person>
- Commit: `<sha>` or `not committed`
- Features: <IDs completed or started>
- Changed: <short description with links to important files>
- Verified:
  - `<command>` — pass/fail and concise result
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

- Last completed task: none
- Safe next task: T1
- Parallel work currently unlocked: none; T9 becomes available after T1
- Known local state: `docs/adversarial-review-revised-browser-agent-proposal.md`
  is an untracked review input and must remain untouched unless explicitly
  requested
- Re-baseline status: not authorized
