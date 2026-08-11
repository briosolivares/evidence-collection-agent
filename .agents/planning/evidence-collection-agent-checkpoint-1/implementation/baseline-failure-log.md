# Baseline failure log — k=3, 2026-08-11

First real milestone run: `npm run evals -- --tasks hacker_news,edgar,openclaw_pr --k 3` (nine live trials, per-trial live oracles). Results JSON: `evals/experiments/2026-08-11T04-48-32-504Z-1adfa719ef9b.json` (moved from `runs/eval-results/` in the 2026-08-10 restructure).

**Headline: 0/3 tasks passed.** hacker_news accuracy 94.4% (completion 2/3), edgar 66.7% (0/3), openclaw_pr 66.7% (1/3).

> **CLOSED 2026-08-11 (re-baseline):** with F1–F4 applied, the same suite passed **3/3 tasks, 9/9 trials, 100% accuracy per task**. All four mechanisms verified in transcripts. Report: `docs/reports/2026-08-11-rebaseline.md`; results JSON: `evals/experiments/2026-08-11_12-41-25am_eval-hacker-news-edgar-openclaw-pr_234a61.json`. One harness blocker was found and fixed first — see "Re-baseline blocker" below.

Per the plan's standing rule, every fix proposed here is a **general mechanism** — no task-specific logic. "Result" is filled in when a mechanism lands and the suite is re-run.

## Failures → mechanisms

### F1. Extra `rank` column in the CSV (hacker_news, 1/3 trials)

- **Evidence:** trial 2 grader detail: `extra: rank (header: rank, title, url, points)`. Trials 1 and 3 produced exact columns. Both pre-baseline flagship demo runs also added `rank` — the agent likes volunteering it.
- **Mechanism (proposed):** one general system-prompt line on schema exactness: when a task specifies an output's structure (columns, fields, format), produce exactly that structure — additions are deviations, not favors.
- **Result:** Applied by user decision: the production prompt now treats named columns, fields, formats, sections, counts, and other structural constraints as exact and forbids unrequested additions. The longer-term initializer/planner-generated output contract was explicitly deferred. **Re-baseline: verified.** All three HN trials produced exactly `title,url,points`; the `rank` column did not recur. Task PASS, 6/6 assertions in every trial.

### F2. `download` gets HTTP 403 through SEC's iXBRL viewer wrapper (edgar, 3/3 trials)

- **Evidence:** filing-page links resolve (via `resolveHref`) to `https://www.sec.gov/ix?doc=/Archives/...` viewer-wrapper URLs; the download tool's `context.request` fetch of that URL returns 403. The *same* raw `/Archives/...` URL loads fine when the agent navigates the real page — Chrome's network stack is accepted where Playwright's request client is not. No trial ever landed the document; the hash assertion failed 3/3 while screenshot + manifest assertions passed 3/3.
- **Mechanism (proposed):** make browser-native capture the accurate default while retaining lightweight HTTP fetch as a separate secondary capability. Capture ordinary resources from a temporary Chrome page's navigation response, capture attachment and JavaScript-triggered downloads from browser download events, and accept a verified direct URL so an agent can bypass viewer wrappers without site-specific logic.
- **Result:** Applied by user decision: `download` accepts exactly one inspected ref or direct HTTP(S) URL and saves exact bytes captured through Chrome with final-resource provenance. Regression fixtures prove that the request client receives 403 while the Chrome-native path succeeds, and cover inline responses, attachments, direct URLs, and JavaScript-triggered downloads. **Re-baseline: verified.** All three EDGAR trials hash-matched the oracle's document (0/3 before). Trial 3 exercised the designed escape path end-to-end: saved the `/ix?doc=` viewer wrapper, detected it on read-back, recovered with a direct `/Archives/` URL. (The union-shaped input schema this rewrite introduced was itself a run-blocking bug — see "Re-baseline blocker" below.)

### F3. Budget guard cuts EDGAR runs mid-recovery (edgar, 3/3 trials; couples with F2)

- **Evidence:** all three trials ended `budget_exceeded` at 11–12 turns while actively recovering from F2 (navigating to raw document URLs to retry). EDGAR's navigation depth (search → results → filing index → document) plus one recovery loop simply doesn't fit in `maxTurns: 12`.
- **Mechanism (proposed):** revisit the default guards in the composition root — they are config values, and accuracy is priority #1. A browser task with error recovery needs headroom (e.g. maxTurns 24); the token ceiling (250k) does the real cost-guarding.
- **Result:** Applied by user decision: the production default is now 24 turns; the configurable 250k cumulative token ceiling is unchanged. A regression test verifies that a run can complete on turn 24 when `maxTurns` is omitted. **Re-baseline: verified.** No trial hit the turn ceiling (deepest run: 11 of 24). The turn wall that killed baseline EDGAR runs is gone. One caveat: EDGAR trial 3 ended `budget_exceeded` on the 250k **token** ceiling at turn 11 — after all artifacts had landed, so it still passed 3/3 — and trials 1–2 finished at 234–235k. EDGAR-depth tasks run close to the token guard; that's the knob to watch next, not turns.

### F4. "OpenClaw" name collision pulls the agent off its anchor (openclaw_pr, 2/3 trials)

- **Evidence:** GitHub hosts both `openclaw/openclaw` (the intended repo, per oracle) and `pjasicek/OpenClaw` (the Captain Claw game engine). Trials start at the intended repo, but: trial 1 noticed the collision, went to "check both," and died `budget_exceeded` at 12 turns with **no answer.md at all**; trial 3 concluded the game repo was intended and answered with its PR #203 (oracle wanted #121863). Trial 2 stayed anchored and passed 3/3.
- **Mechanism (proposed):** a general system-prompt line on anchoring: the run's starting page is task context — prefer interpretations consistent with it and do not wander to alternative interpretations unless the task itself demands disambiguation. (F3's turn headroom also matters here: trial 1 might have recovered given more turns.)
- **Result:** Applied by user decision: the production prompt requires inspecting the initial page before navigating elsewhere and treats a nonblank initial page as deliberate task context and strong evidence unless the task or concrete observed evidence contradicts it. **Re-baseline: verified.** All three trials stayed on `openclaw/openclaw` and passed 3/3 assertions. Trial 3 noticed the repo's oddities (high PR numbers, future dates), flagged them as a caveat in `answer.md`, and stayed anchored — skepticism without derailment. (Trials answered #121925 vs #121926 because a new PR landed mid-eval; the grader's in-window check absorbed it.)

## Re-baseline blocker (found 2026-08-11, fixed before the re-run)

- **Evidence:** the first re-baseline attempt died on turn 1 with API 400 `tools.9.custom.input_schema.type: Field required`. F2's rewrite made `download`'s input a `z.union` of two objects; Zod converts a union to a bare top-level `anyOf` with no `"type": "object"`, which the Anthropic API requires. Deterministic — every run would have failed identically. (Not caught by the 455-test suite: nothing asserted on the generated JSON schema shape.)
- **Fix (commit `7233203`):** single object with optional `ref`/`url` plus a runtime "exactly one of ref or url" refinement — same contract, valid schema. Verified by printing the generated schema, typecheck, full suite, then the nine live runs.
- **General rule for tool authors:** tool input schemas must be top-level objects; express alternatives as optional fields + refinement, never `z.union` at the root. A cheap regression: assert every registered tool's `toApiToolDefs` output has `type: "object"`.

## What held up (worth recording)

- **Provenance:** manifest hashes verified 9/9 — the standing assertion never fired falsely.
- **Prompt caching:** stable `cache_read` on every turn ≥2 of all nine runs.
- **Error recovery behavior:** agents read tool errors and re-routed sensibly (EDGAR trials found the raw document URL; the failure was tooling+budget, not reasoning).
- **Fail-fast harness:** two pre-baseline crashes (about:blank startUrls; SEC oracle rejecting a decorated User-Agent) each died in seconds with precise errors, fixed and committed before this run.

## Science flag — trigger no longer met (2026-08-11)

The revival trigger for **adaptive thinking** (disappointing baseline accuracy) was met by the baseline but is **no longer met after the re-baseline**: the easy suite is at 100% accuracy, 9/9 trials. The recommended sequencing (land F1–F4 first, re-baseline, only then consider the thinking-block change) played out — the mechanisms alone closed the gap. Thinking stays disabled; the T7 types + T9 assembler extension remains shelved until a harder task set produces an accuracy signal that could justify it.
