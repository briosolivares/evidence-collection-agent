# Coordinator Handoff — 2026-08-11 session end

State snapshot for the next coordinator session. Read alongside `plan.md` (checklist authoritative) and `baseline-failure-log.md` (the active work queue).

## Board

**Checkpoint 1 is complete: T1–T18 all committed and verified.** Suite at session end: 221/221 tests across 35 files, typecheck clean. This session landed T14 (runTask + production prompt), T15 (REPL, `npm run agent`), T16 (Langfuse tracing, demo verified server-side), T18 (oracles/graders + the k=3 baseline), plus three baseline-unblocking fixes (eval CLI wired to real runTask; real startUrls; SEC oracle User-Agent in plain `Name email` format — SEC 403s decorated UAs and all non-browser HTTP clients).

## The baseline (the input to everything next)

**0/3 tasks pass at k=3.** hacker_news 94.4% acc (2/3 complete), edgar 66.7% (0/3), openclaw_pr 66.7% (1/3). Human-readable analysis: `docs/reports/2026-08-11-baseline.md`. Failure→mechanism log: `baseline-failure-log.md` — F1–F4 are now implemented: exact-output prompt guidance, Chrome-native downloads with direct-URL support, a 24-turn default, and initial-page anchoring. Re-baseline pending.

**Do not re-baseline without the user's direction.** The longer-term initializer/planner-generated output contract was discussed and explicitly deferred. The disabled-thinking science flag's revival trigger is formally met; enabling it is also the user's call.

## Standing rulings (user-made, binding)

- **Exact output schema:** a task naming CSV columns means exactly those columns, nothing else — graders enforce; extra columns fail.
- Fixes to eval failures must be **general mechanisms**, never task-specific logic (plan's rule, reaffirmed).
- Commit after each verified step, scoped `git add`, planning dir included. Coordinator verifies every worker completion independently before committing (including *all* files a worker touched — the about:blank startUrl slip got through by reading only the graders).

## Working setup (unchanged from last session unless noted)

- Coordinator delegates mechanical code: cyclops `implementer` pane (Codex, gpt-5.6 xhigh — high quality, delegates to its own sub-agents) for big tasks; Claude sub-agents (sonnet) for scoped parallel work. Workers never commit.
- Cyclops quirks still real: large pastes end `verify_failed` but land in the composer — send a one-line flush message; queued messages arrive turns late and stale — always check against the board first (five stale T14/T16 messages drained harmlessly this session).
- `.env` (gitignored): ANTHROPIC_API_KEY + LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL (user's account, live). Never read/print values. Key-needing runs: `npx tsx --env-file=.env <script>`.
- Langfuse skill installed project-local (`.agents/skills/langfuse`, `.claude/`, `skills-lock.json`) by the user — **still untracked**; decide with the user whether to commit.
- The user's `docs/research/browser-layer/*` edits and deleted `rough-idea.md` remain uncommitted, per their instruction.
- Disk was at 100% this session; ~19 GB freed (caches). Deletion commands are classifier-blocked in auto mode — hand the user a one-liner instead.

## Costs observed (for planning re-baselines)

Only the prompt prefix caches; deep browser tasks reach ~20–35k uncached input tokens per late turn. EDGAR/OpenClaw baseline trials ran ~35–50s and often hit the 250k cumulative or former 12-turn ceiling. The production turn default is now 24, while the 250k cumulative token ceiling is unchanged. A nine-run baseline is minutes of wall-clock and noticeable spend — batch mechanism changes before re-running unless attribution demands stages.
