# Coordinator Handoff — 2026-08-11 session end

State snapshot for the next coordinator session. Read alongside `plan.md` (checklist authoritative) and `baseline-failure-log.md` (the active work queue).

## Board

**Checkpoint 1 is complete: T1–T18 all committed and verified.** Suite at session end: 221/221 tests across 35 files, typecheck clean. This session landed T14 (runTask + production prompt), T15 (REPL, `npm run agent`), T16 (Langfuse tracing, demo verified server-side), T18 (oracles/graders + the k=3 baseline), plus three baseline-unblocking fixes (eval CLI wired to real runTask; real startUrls; SEC oracle User-Agent in plain `Name email` format — SEC 403s decorated UAs and all non-browser HTTP clients).

## The baseline (the input to everything next)

**Re-baseline complete (2026-08-11, user-directed): 3/3 tasks pass at k=3, 9/9 trials, 100% accuracy per task** — up from 0/3. All four mechanisms verified in transcripts. Report: `docs/reports/2026-08-11-rebaseline.md` (the original `2026-08-11-baseline.md` now carries a superseded banner); failure log closed out with per-mechanism results. One blocker was found and fixed first: F2's `z.union` input schema produced no top-level `type: "object"` and the API 400'd every run on turn 1 — fixed as a single object with an exactly-one-of refinement (commit `7233203`, tests+typecheck+live runs verified).

The longer-term initializer/planner-generated output contract remains explicitly deferred. **The disabled-thinking science flag's revival trigger is no longer met** (easy suite at 100%); it stays shelved until a harder task set produces an accuracy signal. The easy suite is saturated — further mechanism attribution needs harder tasks.

**Browser batch feature experiment complete (2026-08-11):** fresh control and treatment both passed 3/3 tasks and 9/9 trials, but treatment used `browser_batch` in 0/9 trials. The added schema cost 1,244 first-request prompt tokens with no call compression, so `atomic` remains the product default and `batch-enabled` remains explicit/experimental. Report: `docs/reports/2026-08-11-browser-batch-experiment.md`; implementation and analyzer checklist: `.agents/planning/2026-08-11-browser-batch/implementation/plan.md`. A prompt-guided treatment, if wanted, must be specified as a separate intervention.

**Medium tasks (started 2026-08-11, user-directed):** packages for design rows 6 (`openclaw_merged_prs`) and 8 (`openclaw_contributors`) are built and tested — see `medium-tasks.md` for the decisions (GitHub token added and verified). The mechanism ladder since their 0/2 token-ceiling baseline (`docs/reports/2026-08-11-medium-baseline.md`): ceiling raise (Step 0, `…-medium-ceiling-raise.md`) → moving cache breakpoint + 200k per-request context guard, commit `8d0ea98` (Step 2, `…-medium-rebaseline.md`: first 8/8 trials; 60-turn cap the sole remaining constraint) → **retry on transients + `maxTurns` off, commit `fced2f7`** (spec `.agents/planning/2026-08-11-retry-mechanism/spec.md`). **Latest run (2026-08-11 evening): easy suite still 3/3 at 100% (no regression); medium 0/2 strict, but merged PRs produced a fully verified 8/8 at 76 turns and contributors completed its CSV in all three trials at 85–94 turns — depths the old cap forbade.** First crash-free two-suite eval evening; retry paths went unexercised (no transients). Three separated open failure modes (M1 contributors page-vs-API ranking gap — an eval-design gap, not agent; M2 oracle freshness churn on a hot repo; M3 context-ceiling exhaustion before artifact). Report + candidate-mechanism queue: `docs/reports/2026-08-11-retry-maxturns-off.md` — the user's pick pending; that report's "Candidate next mechanisms" section is the active medium work queue.

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

Superseded twice since first written; current reality (commits `8d0ea98`, `fced2f7`): the moving breakpoint caches the whole conversation — ~2 uncached input tokens per turn even at 90+ turns. `maxTurns` is off by default (`Infinity`); the 200k **per-request** context ceiling is the sole terminating guard (the old 250k cumulative budget and 24/60-turn defaults are gone). Medium trials run 57–94 turns, 4–6.5 min, ~$2.10–3.80 each (weights: 1× input, 1.25× cache write, 0.1× cache read, 5× output at $3/M basis); the easy nine-run suite is ~6.5 min total and near-free. A full easy+medium evening: ~40 min wall-clock, ~$19 of medium spend. Still true: batch mechanism changes before re-running unless attribution demands stages.
