# Judge harness design: Initializer → Worker → Judge

**Status: DESIGN FINALIZED 2026-08-13 — ready to build.** Supersedes the
Proposal 2 strong-form sketch in `plan.md`. Build target: worktree
`evidence-collection-agent-harness`, branch `feat/research-quality-harness`
(fast-forward from main first — main includes the bidirectional-reconcile
prompt, deee16b).

Outer harness loop with a durable run workspace. Fresh worker sessions
rehydrate from disk. The worker proposes completion; the judge verifies.

## Durable workspace

| Path | Owner | Role |
|---|---|---|
| `INTENT.md` | initializer | User goal, constraints, non-goals |
| `CONTRACT.md` | initializer | Objectively checkable criteria + how to prove each |
| `scratch/` | worker | Intermediate / WIP work, including the entity roster |
| `artifacts/` | worker | Published deliverables + evidence |
| `manifest.json` | harness | Provenance for published outputs (existing) |

No PROGRESS.md in v1 — add only if multi-cycle workers fail to orient.

**Read-only enforcement, for free:** `INTENT.md` and `CONTRACT.md` live at
the run-dir root. The existing role enforcement already rejects
`write_file`/`append` outside `artifacts/` and `scratch/`, while `read_file`
reads any run-dir-relative path — so the worker can read but not modify
them. The harness writes both files directly from the initializer's output;
they never pass through worker tools.

## Roles

- **Initializer** (Sonnet, `claude-sonnet-5`) — from the user's request
  only, writes `INTENT.md` + `CONTRACT.md`. No browser, no evidence
  collection. The contract is task-text-derived: exact structure, field
  rules, and for each criterion how the worker must prove it.
- **Worker** (main model) — reads `INTENT.md` + `CONTRACT.md` at run start;
  builds the roster itself (it requires browsing the authoritative source);
  uses `scratch/` for WIP; publishes finals to `artifacts/`; surfaces
  evidence the judge can grade. Continues working until the contract and
  intent are satisfied, then **proposes** completion — a handoff for
  verification, not a claim of success.
- **Judge** (Haiku, `claude-haiku-4-5`) — sees the original task text,
  `INTENT.md`, `CONTRACT.md`, and the surfaced evidence (`artifacts/` +
  manifest). No browser. Returns DONE or CONTINUE + short reason. Does not
  rewrite the contract, does not re-collect.

## Loop

```
user goal
  → initializer (INTENT.md + CONTRACT.md)
  → while under budget (max 2 worker cycles in v1):
       worker → artifacts + evidence → proposes completion
       judge(task text, intent, contract, evidence) → DONE | CONTINUE(+reason)
       if CONTINUE → fresh worker session, rehydrating from disk
```

Harness owns budgets and restarts. Judge DONE ends the run. Judge CONTINUE
after the final cycle ends the run at budget with whatever artifacts exist —
eval graders stay post-hoc and separate either way. The harness records each
judge verdict + reason in run metadata for diagnostics.

## Judge-reason delivery (borrowed from Claude Code's /goal stop hook)

Claude Code's /goal gate evaluates a stop condition with a small fast model
and, on failure, blocks the stop and injects the reason as a plain meta user
message (`Stop hook feedback:\n{reason}`) — no special "judge said" system
framing, same transcript, next turn.

We borrow the shape, adapted to fresh sessions: the worker's no-tool-call
response is the stop proposal; the harness runs the judge; on CONTINUE the
next worker cycle opens with the task text plus the reason as plain feedback
text (`Judge feedback:\n{reason}`) in the opening user message. No judge
schema or special system prompt reaches the worker.

**Documented fallback:** if validation shows the fresh-session
re-orientation tax is too high (lost page state and in-context inspections;
profile-level login survives), switch to Claude Code's exact mechanism —
same-session continuation with the reason as an injected meta user message.

## Worker system-prompt changes

- Multi-entity paragraph: **remove contract authorship** ("alongside it,
  write the output contract…") — the worker reads `CONTRACT.md` instead.
  Roster duty and the bidirectional reconcile language (deee16b) stay.
- Add: at run start read `INTENT.md` and `CONTRACT.md`; consult the contract
  whenever writing output; keep working until it is satisfied.
- Finish paragraph reworded from "signal completion" to "propose
  completion": the response without tool calls submits the run for
  verification and must name the produced files; it is not a success claim.

## Validation plan

- Targets: wikipedia + yc, k=3 each.
- No-tax canaries: hacker_news + merged_prs, k=3 each — watch total
  turns/cost and the judge false-CONTINUE rate on already-good runs.
- Watch item: fresh-session re-orientation tax on CONTINUE cycles (see
  fallback above).
- Known limits, unchanged by this design: the judge has no browser, so it
  catches unproven claims but cannot verify contested facts itself —
  wikipedia converts only if `CONTRACT.md`'s proof requirements force the
  worker to surface counting evidence. mit's Google-login blocker is
  independent of all of this.

## Eval integrity

Nobody inside the run sees oracles or graders. The judge's information diet
is the task text + run dir only — the same as a post-hoc grader's, never
more. Anything phrased in terms of a specific task's oracle stays out of
the initializer and judge prompts.
