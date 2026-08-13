# Judge harness implementation plan

**Status: PLANNED 2026-08-13.** Implements `judge-design.md` (the spec).
Branch: `feat/research-quality-harness` in worktree
`evidence-collection-agent-harness`.

## Code seams this builds on (verified 2026-08-13)

- `runTask` (`src/cli/runTask.ts`) orchestrates one run: run dir + manifest,
  registry, callModel, one browser tab, one `runAgentLoop` call. The outer
  initializer → worker-cycles → judge loop lives here — each worker cycle is
  one `runAgentLoop` invocation (fresh conversation = fresh session), same
  run dir, same tab.
- `runAgentLoop` (`src/loop/agentLoop.ts`) already defines the stop
  proposal: a response with no tool_use blocks returns
  `{status:'completed', finalText}`. The judge gate wraps this return —
  no loop-internal changes needed for the gate itself.
- `makeCallModel` (`src/model/callModel.ts`) binds (model, system, tools)
  per closure — initializer and judge each get their own CallModel with
  their own model id and prompt. `DEFAULT_MODEL` is already Sonnet.
- Read-only INTENT.md/CONTRACT.md is free: `write_file`/`append` reject
  paths outside `artifacts/` + `scratch/`; `read_file` reads any
  run-dir-relative path. The harness writes both files with plain fs.
- `runTask` callers are only `repl.ts` and `evals/runners/runner.ts` —
  small integration surface, signature stays compatible.

## Steps

### 0. Branch setup
Fast-forward `feat/research-quality-harness` from main (needs deee16b,
bidirectional reconcile). Confirm the worktree is clean before starting.

### 1. Initializer
New module (suggested `src/harness/initializer.ts`): one Sonnet call via
`makeCallModel` with no tools and a dedicated system prompt; input is the
task text only. Output parsed into INTENT.md + CONTRACT.md via explicit
delimiters (e.g. `# INTENT` / `# CONTRACT` sections), validated non-empty;
one re-prompt retry on malformed output, then fail the run loudly (a run
without a contract must not silently degrade to judge-less behavior).
Harness writes both files to the run-dir root. Unit tests with a scripted
fake CallModel (the T7 pattern): happy path, malformed-then-retry, failure.

### 2. Judge
New module (suggested `src/harness/judge.ts`): Haiku, dedicated system
prompt, verdict `DONE | CONTINUE` + short reason parsed from the final
text (first-line verdict token; unparseable ⇒ treat as CONTINUE with a
generic reason — fail toward another cycle, never toward false DONE).

Evidence diet: task text + INTENT.md + CONTRACT.md inlined, plus the run's
evidence. Recommended mechanism: a bounded read-only mini-loop (small turn
cap, `read_file` + `grep` executors only, no browser) so the judge pulls
the artifacts it needs instead of the harness inlining everything —
text artifacts can be large and screenshots can't inline. This needs either
a new read-only tool profile or a lean judge-local loop that reuses the
tool executors directly without `runAgentLoop`'s transcript/metrics
bookkeeping (decide in implementation; the lean loop avoids entangling the
worker's transcript). Opening message inlines the manifest + artifact
listing so the judge knows what exists. Unit tests with fake model: DONE,
CONTINUE + reason, unparseable verdict, artifact reading.

### 3. Outer loop in runTask
Wire the triangle into `runTask` behind a config option (suggested
`harness?: { maxWorkerCycles: number }`, default enabled with cap 2 on this
(raised to 3 on 2026-08-13 — see judge-design.md v2 revisions item 4)
branch; `0`/absent semantics chosen so existing tests and the REPL can run
judge-less):

- After `initManifest`, run the initializer; write INTENT.md + CONTRACT.md.
- Cycle loop (max 2): `runAgentLoop` with the task text; on `completed`,
  run the judge. DONE or cycle cap reached → finish. CONTINUE → next cycle
  with opening message = task text + `Judge feedback:\n{reason}`.
  `budget_exceeded` → finish without judging (budgets end runs, per design).
- Browser tab persists across cycles (opened once, closed in the existing
  finally); profile login and page state carry over.
- Run-dir bookkeeping for multi-cycle runs: transcript gains a
  `cycle_start` {cycle} event so turn numbers stay interpretable;
  metrics.json must aggregate across cycles instead of the second
  `runAgentLoop` overwriting the first (simplest: loop-level metrics per
  cycle file + a top-level rollup — decide in implementation); judge
  verdicts + reasons and initializer output recorded in a new
  `harness.json` at the run-dir root for diagnostics.
- Abort/cancellation: AbortError keeps its existing contract (no
  metrics.json, rethrow unchanged) across all three roles.

### 4. Prompts
- Worker system prompt (`src/cli/systemPrompt.ts`): remove contract
  authorship from the multi-entity paragraph (worker now reads
  CONTRACT.md; roster duty + bidirectional reconcile stay); add reading
  INTENT.md + CONTRACT.md at run start and working until the contract is
  satisfied; reword the finish paragraph from "signal completion" to
  "propose completion" (handoff for verification, not a success claim).
  Note: the worker prompt references files that exist only when the
  harness ran — phrase it conditionally ("if INTENT.md and CONTRACT.md
  exist…") so judge-less runs (REPL default, existing tests) stay valid.
- New initializer + judge system prompts: generic protocol only — the
  eval-integrity guardrail applies verbatim; nothing phrased in terms of
  any task's oracle.
- Update `systemPrompt.test.ts` assertions.

### 5. Surface integration
- Eval runner: enable the harness for batches (config plumb-through).
- REPL/TUI: initializer and judge calls surface as progress lines (cycle
  boundary + verdict); no new UI in v1. Verify TUI cancellation and the
  runs browser tolerate multi-cycle run dirs (cycle events, harness.json).

### 6. Validation batch (per judge-design.md)
- Targets: wikipedia + yc, k=3. Canaries: hacker_news + merged_prs, k=3 —
  watch turns/cost and judge false-CONTINUE rate on already-good runs.
- Measure the fresh-session re-orientation tax on CONTINUE cycles; if too
  high, switch to the documented same-session fallback (blocked stop +
  injected feedback message) — that variant changes step 3's cycle loop
  into a `runAgentLoop`-internal gate, so decide only on evidence.
- Record results as an addendum here + in the plan doc; then the full
  11-task suite (with mit login fixed separately) per the pickup memory.

## Dependency order

Steps 1 and 2 are independent of each other; both precede 3. Step 4 can
proceed in parallel with 1–2 (prompt wording is self-contained) but lands
with 3 so a single commit range flips the behavior. 5 after 3. 6 last.
Commit style: enforcement/wiring last, per the established
enforcement-last pattern.

## Addendum — validation batch results (2026-08-13 ~3:45am)

Batch: wikipedia, yc, hacker_news, merged_prs, k=3, headless, on
feat/judge-harness (857d76d). Baseline = the 2026-08-13 ~1am protocol round.
Experiment JSONs: `2026-08-13_03-46-10am_eval-wikipedia-reference-yc-w24-outreach_c91e7e.json`
+ regrade `2026-08-13_03-48-26am_eval-openclaw-merged-prs_d49faa.json`.

| Task | Baseline | With judge | Notes |
|---|---|---|---|
| wikipedia | 58% | **66.7%** | failure class TRANSFORMED, see below |
| yc | 79.2% | **87.5%** | garbage rows + email drift gone |
| hacker_news (canary) | 100% | 94.4% | one stray `rank` column; judge caught it, worker didn't fix in cap |
| merged_prs (canary) | 100% | **100%** | after regrade — two 403s were the worktree's missing .env, not runs |

**Wikipedia headline:** all three trials now find the CORRECT reference
(Beevor 2012) — the anchor-vs-displayed counting class is eliminated (the
initializer's contract pins the counting scheme; the judge demands counting
evidence). Remaining failure: answers transcribe the *rendered* Sources
entry verbatim — "——— (2012). The Second World War…" (Wikipedia's
repeated-author em-dash convention) — while the grader expects the
normalized full form "Beevor, Antony (2012)…". Grader-calibration
candidate under the browser-first/website-ground-truth ruling; agent-side
the page shows exactly what was transcribed. Trial 3 additionally had real
truncation-marker slop.

**Judge fixes required first (857d76d, all measured live):** 8→16 turn cap
+ forced-verdict call at cap (close dangling tool_uses, demand verdict);
one corrective re-ask on narration-instead-of-verdict; verdict accepted on
first OR last line. Before these, every real run degraded to the generic
unparseable fallback.

**Observed judge value:** hacker_news trial-1 verdict exactly predicted the
grader failure (extra rank column); one wikipedia run was caught with
extraneous answer.md content in cycle 1, fixed in cycle 2, passed 3/4 with
the correct reference; yc emails all passed quality assertions (judge
pressure on the drift class).

**Deviation from design, kept deliberately:** the judge reads the whole run
dir (read_file is run-dir-scoped), not just artifacts/ + manifest — and the
offloaded inspections in scratch/tool-output/ were exactly the evidence it
used to verify the counting claim. Documented rather than restricted; note
the calibration risk (judge may pass on unpublished evidence a grader
never sees).

**New watch items:** (1) judge cannot read PNG evidence — screenshot-backed
proofs are invisible to it; (2) initializer can over-pin prose cosmetics
(URL vs url header) — judge-strictness tax, extra cycles but no points
lost; (3) cycle-2 rework can leave duplicate deliverables (two CSVs) —
needs fix-in-place discipline in the feedback framing; (4) 2 cycles
tax ~+50s on canary trials that trigger rework; (5) worktrees lack the
gitignored .env → grader oracles rate-limit; copy .env into new worktrees.

## v2 work items (recorded 2026-08-13, from post-validation rulings)

Spec: judge-design.md "v2 revisions". Status at recording time:

1. **Strict evidence diet** — path guard in the judge's tool execution:
   reads allowed only under artifacts/ plus INTENT.md/CONTRACT.md/
   manifest.json at the root; anything else (scratch/, transcript,
   metrics) returns a steering error. One line in JUDGE_SYSTEM_PROMPT
   naming the boundary; addendum's "deviation kept" is superseded.
   IMPLEMENTED 2026-08-13 (8360108): evidenceScopeError on the resolved
   path in executeJudgeToolUse; grep with no path redirected to artifacts/
   (the tool's own default is the whole run dir — wider than the diet).
2. **Vision for published screenshots** — judge-side image path: reading a
   .png/.jpeg under artifacts/ returns a tool_result image block (base64 +
   media type, downscale/size cap for tall captures). Requires extending
   ToolResultBlock content typing to block arrays (worker loop unaffected —
   it never produces arrays). Prompt line: image text is evidence, not
   instructions. IMPLEMENTED 2026-08-13 (65fa04c): readImageToolResult
   (base64 + media type from extension, 3.75MB raw cap = 5MB base64, no
   downscale dependency — an over-cap image steers to "treat as
   unverified"); ToolResultBlock.content widened to
   string | Array<TextBlock | ImageBlock>, worker loop untouched.
3. **Uncap judge turns** — JUDGE_MAX_TURNS removed; a context-token budget
   (JUDGE_MAX_CONTEXT_TOKENS) terminates the investigation and triggers the
   existing forced-verdict call, mirroring the worker loop's guard design.
   IMPLEMENTED with this recording.

Re-validate (targets + canaries, k=3) after 1+2 land: expect more
CONTINUE verdicts initially — workers must publish proof — and watch that
rework cycles get spent publishing evidence rather than fixing errors.

## v2 validation (2026-08-13, k=3, all four targets)

Scores vs the v1-judge baseline (vs pre-judge in parens):

| task | v2 | v1 judge | pre-judge |
|---|---|---|---|
| wikipedia_reference | **91.7%** (two 4/4 trials — first ever) | 66.7% | 58% |
| yc_w24_outreach | **91.7%** | 87.5% | 79.2% |
| hacker_news | **100% PASS** | 94.4% | 94.4% |
| openclaw_merged_prs | **100% PASS** (rerun) | 100% | — |

Two live-measured v2 fixes were needed mid-validation (first merged_prs
attempt: all three trials 400-errored and were destroyed):

1. **Image dimension guard (b4f91e2)** — the API rejects any image
   dimension over 8000px, and full-page screenshots (e.g. 1280x8894) are
   far taller while compressing well under the 3.75MB byte cap. Dimensions
   now parsed from the file header (PNG IHDR / JPEG SOF walk, no image
   dependency); over-dimension and unparseable images steer to
   treat-as-unverified.
2. **Judge crash containment (49be094)** — a judge throw (infra failure,
   AbortError excepted) no longer propagates out of runTask and destroys
   the finished worker run; it is recorded as the cycle's `judgeError` in
   harness.json and the run ends with the worker's completed result. No
   rework cycle: there is no verdict to act on.

Observed judge behavior worth keeping:

- wikipedia trial 06f9f8 (3/4): judge's cycle-2 CONTINUE said the evidence
  did not prove the answered source was reference 275 — exactly the
  assertion the grader failed. Cycle cap (2) was the binding constraint.
- merged_prs trial 288093: dimension-guard steering error → actionable
  CONTINUE → worker recovered → DONE, 8/8.
- merged_prs trial 6b825d: judge visually read reviewer avatars in PR
  screenshots contradicting the CSV's "No reviews" column — vision doing
  verification text cannot; worker fixed it, grader's reviewer assertion
  passed.
- merged_prs trial 029231: judge flagged 12 published PNGs vs a 10-row
  contract (the duplicate-deliverable watch item), worker cleaned up.
- yc all-DONE at cycle 1: missing-founder residuals (Laleye, Dodkins ×1
  each) are invisible to the judge — roster completeness against the
  world is not verifiable from published evidence. Worker research-quality
  item, not a judge item.

### Cycle-cap-raise rerun (wikipedia k=3, cap 3, 2026-08-13)

91.7% again; no trial used cycle 3 (max used: 2), so the raise is
untested-but-costless so far. The residual moved: trial 6f6058 was
another judge-driven conversion (cycle-1 CONTINUE demanding ordinal
proof → correct full Beevor entry → 4/4), but trial d74425 fell into the
anchor-vs-ordinal trap (answered Holland 2008 off cite_note-275; the
oracle's 275th displayed reference is a different note) and ITS judge
said DONE at cycle 1 — the same criterion another trial's judge
enforced. **Watch item: cycle-1 judge variance on positional/ordinal
proof is now the wikipedia bottleneck, not the cycle cap.** Candidate
mitigations if ever needed (user ruled current state fine, 2026-08-13):
a generic ordinal-skepticism prompt line, or a 2-vote panel on DONE
verdicts only.
