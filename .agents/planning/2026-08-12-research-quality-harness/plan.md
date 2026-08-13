# Research-quality harness improvements: four proposals

**Status: PROPOSED 2026-08-12 late night — not scheduled.** Ideas from the
post-batch failure review with the user, grounded in the 2026-08-12 nine-task
run (`evals/experiments/2026-08-12_05-43-30pm_eval-mit-sororities-openclaw-merged-prs_9d69b4.json`)
and the mit round-3 validation. The infrastructure failure modes are closed
(decode stall, bot-blocks via the headed lane); what remains is research
quality — and these four target it. Ranked by expected payoff.

## The evidence these aim at

- **yc_w24_outreach 75%, 0/3 clean trials, a different narrow miss each time:**
  trial 1 included two founders not on any oracle-listed YC W24 AI company and
  covered only 4 of 5 companies; trial 2 was perfect except one implausible
  LinkedIn handle; trial 3 had all 5 companies and 12 valid founders but
  missed one co-founder (Artisan: Rupert Dodkins). Shape was perfect 3/3 —
  the misses are scope, completeness, and identity verification.
- **wikipedia_reference 92%:** trials 1 and 3 exact; trial 2 produced a
  well-formed answer.md that did not contain the actual CITEREFBeevor2012
  bibliography text — content selection/transcription, not structure.
- **mit_sororities trial 2 (round 3):** collected all 182 members across all
  12 cohorts, then wrote affiliations as "Alpha Chi Omega (MIT)" — unrequested
  decoration in an enum-like field; the exact-structure grader rejected the
  lot. A field-level contract violation, not a research failure.

**Addendum (2026-08-12 headed-lane batch):** wikipedia went 0/3 — all three
trials returned the SAME wrong reference. Elision was suspected and
investigated (transcript check): cleared — runs were ~16 turns with the
answer written from live context. Actual cause: every agent jumped to the
HTML anchor `cite_note-275` and assumed anchor number = displayed reference
number; the oracle counts the displayed 275th entry, and on Wikipedia
anchor IDs follow wikitext creation order, not rendered position. An
unverified counting assumption — the same failure family as yc's identity
slips, and a second concrete case for Proposal 2's judge (a verifier asking
"did you confirm the displayed number?" catches it; prose confidence does
not). Same batch: mit trial 1 repeated the decorated-affiliation rejection
(~30 rows) and had no Sheets URL (CAPTCHA + logged-out profile), and elon's
two 6/7s were grader time-format parsing, not agent error.

## Proposal 1 — enumerate-then-fill protocol (yc-class completeness)

For multi-entity collection tasks, the agent assembles rows from whatever its
searches surface, with no explicit roster to audit against. Missing
Rupert Dodkins is the textbook symptom: nothing existed to check off.

**Mechanism:** require a two-phase protocol — first build the entity roster
from the authoritative source (the YC directory lists each company's
founders; a sorority site lists its cohorts) and write it to `scratch/` as a
checklist artifact; only then fill rows, checking each entry off; before
finishing, reconcile the output against the roster and account for gaps.

**Where:** cheapest as a system-prompt research-protocol paragraph
(`src/cli/systemPrompt.ts`). A planner pre-stage that emits the checklist as
its first artifact is the heavier variant — start with the prompt, escalate
only if the model won't follow it.

**Validation:** yc_w24 k=3 — the "exactly five companies and every
oracle-listed founder" assertion is the target; mit cohort coverage (the
two trials that missed the same 3 cohorts) should also move.

## Proposal 2 — verify-before-finish (wikipedia-class content slips)

Trial 2's wrong bibliography text would have failed the agent's own check if
it had one: re-derive the claim from the live page and diff against what you
wrote. The grader caught it with a mechanical containment check; the agent
can run the same discipline pre-submit.

**Mechanism:** a finalize-gate protocol line — before ending, re-verify every
quoted or copied fact against its source (re-inspect the page, compare
verbatim) and re-read the task statement against the produced artifacts.
Generic on purpose: restate acceptance criteria, then self-check.

**Where:** system prompt first. A harness-enforced variant (a mandatory
self-review turn before the loop accepts a no-tool-call finish) is possible
at the `src/loop/` seam but adds a turn to every task — measure the prompt
version first.

**Validation:** wikipedia_reference k=3 expecting 3/3; watch total turns/cost
for regression on short tasks (hacker_news) — the protocol must not balloon
easy runs.

## Proposal 3 — output-contract pinning up front (mit-class format loss)

The 182-member trial failed wholesale on decoration the task never asked
for. The contract ("affiliation: the sorority name verbatim, no annotations")
was never made explicit anywhere the model would re-read at write time.

**Mechanism:** before collecting, the agent writes the output contract —
exact columns, field-level rules (verbatim enum fields, formats, units) — as
a short artifact, and consults it when writing rows. Pairs naturally with
Proposal 1's roster (same pre-collection planning beat). The existing prompt
already says "exactly these columns"; this extends the discipline to field
*values*.

**Where:** system prompt; candidate one-liner already identified in the
elision plan ("write enum-like fields verbatim — no added annotations").

**Validation:** mit headed k=3 — the wholesale-rejection mode (structure
violation on otherwise-complete data) should disappear; a flipped trial 2
would have graded ~6/7.

## Proposal 4 — extract_quote tool (transcription becomes capture)

The deepest fix, and the most evidence-agent-native: today "reproduce the
source text exactly" means the model *retypes* text through token
generation — every reproduction is a paraphrase risk. A tool that
mechanically extracts the text of a page region (by a11y ref, like click's
targeting) makes fidelity a guarantee and gives the quote provenance.

**Mechanism:** new tool (e.g. `extract_text` / `quote`) — given a ref (and
optionally a range), returns the element's text content verbatim from the
live DOM; optionally writes it via `writeArtifact` so the manifest hashes
the quote at capture time (the invisible-plumbing rule extends to quotes).

**Where:** `src/tools/` one-directory-per-tool; **append after the existing
tools in registration order** (the authTools precedent — appending keeps the
cached prompt prefix stable). Prompt gains one line steering verbatim-quote
tasks to it.

**Cost/risk:** a real tool build (schema, executor, tests, prompt line);
overlaps with inspect_page (which already surfaces text) — the delta is
verbatim fidelity + provenance, so keep the scope to exactly that.

**Validation:** wikipedia_reference k=3 (the containment assertion passes by
construction if the agent uses the tool); spot-check that other tasks don't
misuse it as a general scraper.

**Addendum 2 (2026-08-13, first protocol validation):** merged_prs 100%
(3/3 clean), hacker_news 100% (no prompt tax), yc zero missing-founder
failures (the protocol's target class held) but 79.2% on residual slop.
Forensics on the yc garbage row (trial 2c564d): a SINGLE 7,433-char
write_file (chunking guidance ignored) whose content value ended with a
training-convention `</content>` tag the model never opened — no harness
source or tool result ever shows such tags, so it is model slop, not a
write-path bug. The protocol's reconcile ran but only ONE direction:
turn 89 read the file back, turn 90 grepped `^[A-Za-z]+ [A-Za-z]+,https`
and confirmed 11/11 roster rows — a check blind to extra junk lines.
Lesson for Proposal 1's next iteration (worktree agent): reconcile both
directions — every roster entry in the output, AND every output line a
valid contract row. A judge subagent (Proposal 2) catches this trivially.

## Proposal 5 — cheaper repeat-visit page representation (delta inspect)

Origin: the cache-context-guard spec
(`.agents/planning/2026-08-11-cache-context-guard/spec.md`, decision 2):
"if context_budget deaths appear, the remedy is cheaper repeat-page
representation, not a bigger cap." Resurfaced by the user 2026-08-12 while
weighing elision's costs.

**Mechanism:** when inspect_page targets a URL already inspected this run,
return a terser view — a delta against the previous outline ("unchanged
except…") or a compressed outline — instead of the full dump. The prior
full inspect is already on disk (scratch/tool-output offload), so the diff
base exists.

**Relationship to elision:** complementary, not competing. Elision
compresses *history* (old inspects stub out); this compresses *repeat
visits* — which elision made more frequent, since the prompt now tells the
agent to re-inspect pages it lost. Together they bound both directions of
inspect cost.

**Risks:** a terse repeat view degrades exactly the verbatim-fidelity cases
(same tension as Proposal 4 — pair them: mechanical quotes make terseness
safe); dynamic pages need change detection that doesn't lie; "unchanged"
must be provably true (hash the outline) or the model gets a stale view it
trusts. Defer until inspect volume is a measured cost driver post-elision.

## Mapping to long-running-agent engineering (Bustamante) — the subagent angle

Reviewed against
https://nicolasbustamante.com/blog/long-running-agent-engineering
(2026-08-12, user prompt: "I feel a bit off by the fact that we haven't used
subagents yet"). Findings:

- **We already implement half his stack, at the eval layer:** his durable
  workspace state layer = our run dir (scratch/ + artifacts/ + manifest +
  transcript; the elision fix added his record-to-disk discipline verbatim);
  his verification-as-backpressure + test oracles + external judge = our
  grader/oracle harness (judges only run-dir evidence, never the transcript);
  budgets and append-only artifact capture likewise.
- **The gap: the initializer/worker/judge triangle exists only *around* the
  agent, not inside a trial.** Within a run the worker judges itself — and
  his core claim (the entity incentivized to finish must not judge
  completion) is exactly our failure data: the "(MIT)" decoration trial and
  wikipedia trial 2 both finished confident and wrong.
- **Proposal 2 therefore has a weak and a strong form.** Weak: prompt-only
  self-review (same context, same biases). Strong: a **judge subagent** —
  fresh context, reads only the task text + run dir (the grader's exact
  information diet), checks artifacts against the task's stated criteria,
  returns a punch list the worker must clear before finishing. Needs no
  browser → one extra model call per trial; the cheapest first subagent.
- **Proposals 1+3 are his "initializer" role:** roster = expanded feature
  list, contract = spec, written before collection so the worker cannot
  later invent a minimal definition of done (his phrasing; our
  missing-cohorts failure).
- **Ralph loop / fresh worker sessions = our escalation path, not a current
  need.** We fixed context rot surgically (elision) because one live shared
  browser session makes mid-investigation handoffs costly. If tasks outgrow
  the elided window (hundreds of entities, multi-hour runs), per-roster-entry
  workers rehydrating from scratch/roster.md is the architecture; the run
  dir already supports it.
- **Why no subagents so far, honestly:** tasks fit one context post-elision,
  the single browser serializes work anyway, and subagents multiply cost.
  All three are arguments against worker swarms — none applies to the judge.
- **Deliberately not imported:** session-start smoke tests, git baselines,
  sandbox rehydration — multi-day software-project machinery; our trials are
  bounded 15–60 min single-goal runs. Adopt the roles, skip the ceremony.

**Revised sequencing implication:** the judge subagent may deserve to jump
the queue over prompt-only Proposal 2 — same validation batch, structurally
stronger mechanism, and it establishes the subagent seam (a second
callModel consumer against a run dir) that the initializer can later reuse.

## Eval-integrity guardrail (applies to all four)

None of these may encode a grader's specific checks — that's overfitting to
the eval. The legitimate form is generic protocol: enumerate before
collecting, verify claims against sources before finishing, pin the output
contract, capture quotes mechanically. Anything phrased in terms of a
specific task's oracle is out.

## Deliberately not proposed

- Giving graders' assertion lists to the agent (integrity, above).
- LinkedIn behind the headed logged-in lane for yc identity checks — real
  option, but a policy/ToS conversation first; the two-source rule (only
  record a linkedin_url corroborated by the founder's other footprint:
  company site, YC profile, X bio) fits inside Proposal 2 without it.
- Grader-side fixes (the name-vs-handle LinkedIn heuristic may false-flag
  terse real handles like `binw` — worth eyeballing, but that's grader
  calibration, tracked separately from harness work).

## Open questions

1. One protocol paragraph or three separate lines? Prompt budget is finite
   and every line taxes every task — measure with the cheap tasks.
2. Does Proposal 1's checklist belong in `scratch/` (private) or `artifacts/`
   (graded)? Leaning scratch: it's working state, not evidence.
3. Proposal 4 ref-targeting: same ref lifetime rules as click/type (refs only
   from the latest inspects, per the elision window)?
4. Sequencing: 1–3 are prompt-only and could ship as one commit + one
   validation batch (yc, wikipedia, mit, hacker_news as the cost canary);
   4 is a separate tool build.
