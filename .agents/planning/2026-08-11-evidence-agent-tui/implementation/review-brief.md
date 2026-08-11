# Review Brief — Sherlock TUI Implementation Plan

For: reviewer. From: the planning session (Claude, worktree `evidence-agent-tui`).

Context: PDD planning for the evidence-agent TUI ("sherlock") is complete in the worktree
`/Users/briosolivares/Desktop/Code/evidence-collection-agent/.claude/worktrees/evidence-agent-tui`
(branch `worktree-evidence-agent-tui`). Work inside that worktree; do not switch branches.

- Implementation plan: `.agents/planning/2026-08-11-evidence-agent-tui/implementation/plan.md` (9 steps)
- Design doc for reference: `.agents/planning/2026-08-11-evidence-agent-tui/design/detailed-design.md`

## Task 1 — features.json

Create `.agents/planning/2026-08-11-evidence-agent-tui/implementation/features.json`: a
machine-readable feature checklist derived from the implementation plan. Each item must have at
minimum: an `id`, the `step` number it belongs to, a short `description`, and a `status` field that
is strictly `"pass"` or `"fail"` (initialize everything to `"fail"` — nothing is implemented yet).
One item per independently checkable feature, not just one per step.

## Task 2 — progress.md

Create `.agents/planning/2026-08-11-evidence-agent-tui/implementation/progress.md`: an append-only
notebook for implementation work. Seed it with a short header stating the convention: entries are
only ever appended (timestamped, newest last), never edited or deleted.

## Task 3 — revise plan.md with verification surfaces

Revise `plan.md` so every step has a strong verification surface an agent can check mechanically.
Each step gains a `Verify:` section whose checks judge surface evidence against a narrow
condition — e.g. "this file exists", "this command exits 0", "this command's output contains /
matches X", "`npx vitest run tests/tui/format.test.ts` passes" — not vague criteria like "works
correctly" or "feels right". Where a step's demo is inherently visual, still pin down the
mechanically checkable subset (files created, process starts and exits cleanly, snapshot test
passes) and mark the visual remainder explicitly as human-judged. Keep the existing step structure
and content: you are adding verification, not rewriting intent.

Consistency requirement: the `features.json` statuses should be flippable to `"pass"` exactly by
running the corresponding `Verify:` checks — keep the two artifacts aligned.

When done, reply via cyclops with a summary of what you changed.
