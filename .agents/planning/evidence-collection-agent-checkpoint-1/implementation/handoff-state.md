# Coordinator Handoff — 2026-08-10 session end

State snapshot for the next coordinator session. Read alongside `plan.md` (its Progress checklist is authoritative for task status).

## Board

**Committed & verified: 14/18** — T1–T13 and T17. Every commit passed the coordinator's independent verification first: full/scoped `npm test`, `npm run typecheck`, running the task's demo where cheap, and a direct read of the task's load-bearing file (e.g. `resolveRunPath`, `capResult`, `agentLoop`'s content-decided completion, the `BrowserAdapter` interface). Suite at session end: **136/136 tests across 22 files, typecheck clean.**

**Remaining: T14 → (T15 ∥ T16) → T18.**

## Immediate next actions

1. **T14** (runTask wiring + system prompt) — the composition root. All inputs are landed: loop (T7/T8), model client (T9), all ten tools (T6, T11, T12, T13), run-dir/manifest (T2/T3). Spec: plan.md T14. The system prompt joins the stable cached prefix — byte-identical across calls, no task-specific content ever.
2. **User checkpoint before/with T14:** run `npx tsx --env-file=.env demos/09-real-agent.ts` — first live agent run; the demo prints an explicit `prompt-cache check: PASS/FAIL` (design requires `cacheReadInputTokens > 0` from turn 2).
3. **T14's flagship demo** (live Hacker News CSV) is the user's big manual checkpoint — they watch it.
4. Then T15 (REPL) ∥ T16 (Langfuse). **T16 demo needs the user to create a Langfuse account** (free Hobby tier) and set `LANGFUSE_*` env keys; the code path must be a clean no-op unconfigured, so implementation needn't wait on the account.
5. T18 easy-task oracles/graders + the k=3 baseline — user watches the baseline runs (standing human overlay).

## Working agreements (established this session)

- Coordinator (this session: "planner" in cyclops) delegates ALL mechanical code to workers, verifies each completion independently, ticks the plan.md checklist, and commits per task with **scoped `git add`** (planning dir `.agents/planning/` included in commits; user requested both).
- Subagent workers get: pointer to plan.md section + Conventions, list of landed modules to build on, explicit touch-only file constraints (prevents parallel-worker collisions), definition of done (tests + typecheck), and a report format. They never commit.
- The **cyclops implementer** (Codex CLI, tmux pane, gpt-5.6 xhigh) owned the whole browser track T10–T13 — high quality throughout; it delegates to its own subagents and runs delegated reviews. Currently idle/standing by. Available for T15/T16-era work next session.
- User instruction: commit after each verified step. Pre-existing uncommitted `docs/research/*` edits and deleted `rough-idea.md` are the user's own — leave uncommitted.

## Environment & secrets

- `ANTHROPIC_API_KEY` lives in `.env` (gitignored, untracked — verified). **Never read, print, or commit it.** Run key-needing demos with `npx tsx --env-file=.env <demo>`.
- Chrome present at /Applications/Google Chrome.app; persistent profile dir `chrome-profile/` (gitignored). Playwright 1.62.1 uses `channel: 'chrome'` — no `npx playwright install` needed. TypeScript 7.0.2 (native compiler) — typechecks clean; pin 5.x only if it ever misbehaves.

## Cyclops delivery quirks (hard-won; don't rediscover)

- Large pastes to the Codex pane routinely end `verify_failed → attention_required` **even when they land**, and sometimes sit unsubmitted in the composer. Fix: send a one-line flush message ("Pasted content above is your go-signal — proceed"); it submits the stacked composer content. Never `tmux send-keys` (cyclops invariant).
- Codex once popped a "Create a plan?" modal that blinded cyclops (`? unknown`) — only the human operator can dismiss it (esc). Ask the user.
- Receipts are unreliable for this pane; confirm delivery by `cyclops read implementer` and checking the pane.
- Inbound messages queue while the coordinator's pane shows "working" — stale messages can arrive turns later. **Check any implementer message against the board before acting; several arrived after their subject was already resolved.**

## Design decision to surface to the user (science flag)

**T9 disables adaptive thinking** (`thinking: {type:'disabled'}`), deviating from the design's "thinking stays at API defaults": Sonnet 5's default adaptive thinking emits thinking blocks that the frozen T7 message types (`text`|`tool_use` only) cannot replay, which risks 400s in tool-use loops. Disabling was the only config consistent with the landed loop contract; the assembler fails fast on uncarryable block types. **Revival trigger:** if T18 baseline accuracy disappoints, consider enabling thinking + extending message types to carry thinking blocks (accuracy is priority #1). The user has not yet ruled on this.

## Task-tracker mirror

The harness task list (#1–#18) mirrors plan.md's checklist; #14–#16, #18 pending at session end.
