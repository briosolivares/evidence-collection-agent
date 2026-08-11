# Baseline failure log — k=3, 2026-08-11

First real milestone run: `npm run evals -- --tasks hacker_news,edgar,openclaw_pr --k 3` (nine live trials, per-trial live oracles). Results JSON: `evals/experiments/2026-08-11T04-48-32-504Z-1adfa719ef9b.json` (moved from `runs/eval-results/` in the 2026-08-10 restructure).

**Headline: 0/3 tasks passed.** hacker_news accuracy 94.4% (completion 2/3), edgar 66.7% (0/3), openclaw_pr 66.7% (1/3).

Per the plan's standing rule, every fix proposed here is a **general mechanism** — no task-specific logic. "Result" is filled in when a mechanism lands and the suite is re-run.

## Failures → mechanisms

### F1. Extra `rank` column in the CSV (hacker_news, 1/3 trials)

- **Evidence:** trial 2 grader detail: `extra: rank (header: rank, title, url, points)`. Trials 1 and 3 produced exact columns. Both pre-baseline flagship demo runs also added `rank` — the agent likes volunteering it.
- **Mechanism (proposed):** one general system-prompt line on schema exactness: when a task specifies an output's structure (columns, fields, format), produce exactly that structure — additions are deviations, not favors.
- **Result:** —

### F2. `download` gets HTTP 403 through SEC's iXBRL viewer wrapper (edgar, 3/3 trials)

- **Evidence:** filing-page links resolve (via `resolveHref`) to `https://www.sec.gov/ix?doc=/Archives/...` viewer-wrapper URLs; the download tool's `context.request` fetch of that URL returns 403. The *same* raw `/Archives/...` URL loads fine when the agent navigates the real page — Chrome's network stack is accepted where Playwright's request client is not. No trial ever landed the document; the hash assertion failed 3/3 while screenshot + manifest assertions passed 3/3.
- **Mechanism (proposed):** make `download` resilient by design: fall back to an in-page fetch (the page's own network stack, session and headers) when the request-context fetch fails, and/or capture Playwright download events — both already noted in the tool's docstring as the alternative for wrapper/JS-triggered downloads. Wrapper-URL hrefs are a general web pattern (viewers, redirectors), not an EDGAR quirk.
- **Result:** —

### F3. Budget guard cuts EDGAR runs mid-recovery (edgar, 3/3 trials; couples with F2)

- **Evidence:** all three trials ended `budget_exceeded` at 11–12 turns while actively recovering from F2 (navigating to raw document URLs to retry). EDGAR's navigation depth (search → results → filing index → document) plus one recovery loop simply doesn't fit in `maxTurns: 12`.
- **Mechanism (proposed):** revisit the default guards in the composition root — they are config values, and accuracy is priority #1. A browser task with error recovery needs headroom (e.g. maxTurns 24); the token ceiling (250k) does the real cost-guarding.
- **Result:** —

### F4. "OpenClaw" name collision pulls the agent off its anchor (openclaw_pr, 2/3 trials)

- **Evidence:** GitHub hosts both `openclaw/openclaw` (the intended repo, per oracle) and `pjasicek/OpenClaw` (the Captain Claw game engine). Trials start at the intended repo, but: trial 1 noticed the collision, went to "check both," and died `budget_exceeded` at 12 turns with **no answer.md at all**; trial 3 concluded the game repo was intended and answered with its PR #203 (oracle wanted #121863). Trial 2 stayed anchored and passed 3/3.
- **Mechanism (proposed):** a general system-prompt line on anchoring: the run's starting page is task context — prefer interpretations consistent with it and do not wander to alternative interpretations unless the task itself demands disambiguation. (F3's turn headroom also matters here: trial 1 might have recovered given more turns.)
- **Result:** —

## What held up (worth recording)

- **Provenance:** manifest hashes verified 9/9 — the standing assertion never fired falsely.
- **Prompt caching:** stable `cache_read` on every turn ≥2 of all nine runs.
- **Error recovery behavior:** agents read tool errors and re-routed sensibly (EDGAR trials found the raw document URL; the failure was tooling+budget, not reasoning).
- **Fail-fast harness:** two pre-baseline crashes (about:blank startUrls; SEC oracle rejecting a decorated User-Agent) each died in seconds with precise errors, fixed and committed before this run.

## Science flag now live

The handoff's revival trigger for **adaptive thinking** (disabled in T9 because the loop's message types can't replay thinking blocks) is met: accuracy disappointed on 2 of 3 tasks. Enabling it means extending the T7 message types + T9 assembler to carry thinking blocks. User decision pending — recommended sequencing is to land F1–F4 first (cheap, targeted), re-baseline, and only then spend the thinking-block change if accuracy still lags.
