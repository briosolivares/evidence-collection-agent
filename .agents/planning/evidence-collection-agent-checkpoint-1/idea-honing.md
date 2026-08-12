# Idea Honing

Grilling session started 2026-08-10, on `rough-idea.md`. Questions asked in rounds; answers recorded as they arrive.

## Taken as settled (from repo docs, unless objected)

- **Browser layer:** Playwright driving local Chrome — visible window, persistent profile — behind an engine-neutral `BrowserController`; `BrowserSessionProvider` separates local from hosted session acquisition. Escalation on observed blocks only: Patchright → Camoufox (pinned fingerprint) → paid stealth. A Browserbase provider can be added to measure block rates. (Source: `docs/research/browser-layer/recommendation.md`.)
- **Loop ownership:** we build the agent loop ourselves, Claude Code–style — the brief evaluates the agent design itself, so outsourcing it (Browser Use, Stagehand-as-orchestrator) is off the table. (Source: recommendation.md + work-trial brief.)
- **Tracing:** Braintrust. (Source: design doc; note no Braintrust key in `.env` yet — only `ANTHROPIC_API_KEY` is configured.)
- **Priority order from the brief:** Accuracy > Generability > Scalability (thousands) > Consistency > Speed.

## Round 1

### Q1 — What did the Tinah sync change?
The worklog says "revisiting architecture after tinah sync." What came out of that sync — which parts of the design are being reconsidered, and toward what? This gates the architecture questions (loop shape, SDK vs. hand-rolled, language, model strategy), so those wait for Round 2.

**Recommended:** —(fact only you have)

**Answer:** Tinah asked three things: (1) why not use Claude Code's tools, (2) what the research actually taught, (3) why build a basic loop and add known-future needs later instead of architecting for them proactively. Decision: **stick with the minimal hand-rolled loop first** — nothing is running yet, and a working baseline beats a grander design on paper.

**Follow-ups spawned:**
- Write the "why hand-rolled, why minimal-first" rationale into the design doc — evaluators grade design decisions, and Tinah's question is exactly the question they'll ask.
- Decide the precise reuse boundary with Claude Code: borrow *mechanisms* from the harness research (bounded results → artifact files with previews, append-only transcript, stable prompt prefix) without adopting the SDK. → Round 2 question.

### Q2 — Timebox
When is the work trial due, and roughly how many working hours/days remain? This sets the budget for everything downstream (how many evals get automated graders, how much of the scale story gets built vs. spec'd).

**Recommended:** —(fact only you have)

**Answer:** ~25 working hours remain. Explicit instruction: don't judge what's achievable in that time — the aim is a project that performs extremely well on the evals and satisfies the constraints. Implication taken: the timebox informs *ordering* (what gets built first / cut last), not scope pessimism.

### Q3 — Success bar across the 11 evals
Pass all 11, or prioritize? There's also a hidden eval set, which rewards general mechanisms over per-task tuning.

**Recommended:** All 3 easy + all mediums as the target; hards best-effort. Never hard-code per-task logic — every fix should be a general mechanism (better page inspection, better CSV tooling), since the hidden set punishes overfitting.

**Answer:** **All 11 passing is the target.** Overfitting rule adopted: no task-specific logic anywhere — failures are fixed by improving general mechanisms; the visible evals are a test set for general capability. Strategy note: the win is a well-designed harness around the model that generalizes across tasks, and most harness engineering happens *after* a minimal agent is running.

### Q4 — How accuracy is quantified
The design doc literally says "quantify this somehow." Proposal on the table: each task decomposes into assertions; run k=3 trials per task; **accuracy** = mean fraction of assertions passed; **completion** = 1 iff all assertions pass; **consistency** = all k trials complete. Manual grading only where automation is disproportionate (screenshot contents).

**Recommended:** Adopt the above.

**Answer:** **Adopted.** Tasks decompose into assertions (auto-checked where possible, manual where not). k=3 trials per task. Accuracy = mean assertion pass rate; a trial completes iff all assertions pass; **"a task passes" = all 3 trials complete** — this is the development done-bar and the reported result ("11/11 at 3/3"), not a runtime mechanism. Fallback if eval runtime bites on slow tasks: k=2 for expensive tasks, k=3 elsewhere. Consequence for the harness (→ Round 2): live-site tasks need per-trial oracle capture or structural assertions rather than exact values.

### Q5 — Accounts and logins
Tasks needing sessions/accounts: X feed (Elon tweets), Google Sheets (sorority task), LinkedIn URLs (YC + contributors tasks). Which accounts exist and are you comfortable letting the agent drive them from your persistent Chrome profile? Burner vs. personal matters for X especially (automation can get accounts flagged).

**Recommended:** Real Google account (low risk, needed for Sheets write); logged-out LinkedIn treated as best-effort (public profile URLs only); X ideally a burner or an account you can afford to have flagged.

**Answer:** **X: burner account** (to be created). **Google: fresh account** (to be created) — it owns the Sheets write for the sorority task. **LinkedIn: stay logged out** — tasks only need public profile URLs; "URL findable without login" becomes the assertion. Both new accounts get logged into the agent's persistent Chrome profile once, manually, and the sessions ride along thereafter. Setup note: a brand-new Google account may hit extra verification friction on first scripted use — worth logging in and using it manually once before the agent touches it.

### Q6 — Scalability: build or spec?
"Scalable to thousands of samples" — demonstrate or design-for? Building real queue infra (Temporal etc.) eats the timebox.

**Recommended:** Design-for and demonstrate modestly: architecture doc describes queue + stateless workers + per-site rate limits; the demo proof is running the full eval suite concurrently on this machine. No Temporal.

**Answer:** **Spec only — nothing built now.** The design doc describes the scale architecture: worker pool with a configurable concurrency cap (2–3 on this 8 GB machine — checked; contexts share one Chrome instance), per-site serialization (parallel across sites, queued within a site — also a bot-detection measure), and the cap-is-config argument (same harness pointed at Browserbase runs 100). Eval runs are **sequential** until a minimal agent is running and a baseline exists; the worker pool is deferred harness engineering. No Temporal, no queue infra.

### Q7 — Interface scope
The brief says interface + auth are "up for you to spec out" and that evaluation weighs agent quality. CLI now, or build a UI?

**Recommended:** CLI as the working interface (task string in, artifacts out). Product interface + auth system get a written spec section in the design doc, not code.

**Answer:** **Interactive terminal agent, Claude Code–style — with a written spec.** The product is a terminal-based browser agent: a persistent shell experience where typing a task triggers the query loop directly, results stream back, and the session holds state for follow-ups. Explicit scope guard: the interface is *not* the most important part — v1 implementation is a thin REPL (read task → stream loop progress → prompt again), no TUI framework, no slash commands, no fancy rendering. The written spec covers the interactive interface + the auth/credential story for the audit context.

## Round 1 verdict

Frontier round 1 fully settled. Round 2 (architecture) unblocked: language/runtime, Claude Code reuse boundary, model strategy, context/page representation, evidence output conventions, eval oracle strategy, tracing.

## Round 2

### Q8 — Language and runtime
**Recommended:** TypeScript — every existing artifact (harness research on Claude Code's TS source, design-doc idioms, Playwright, Claude Code–style terminal product) already assumes it.

**Answer:** **TypeScript.** Added rationale: zod for schema validation — tool inputs get zod schemas (satisfying the "tool input validation" guardrail), and zod schemas convert to the JSON Schema the model needs in tool definitions, so one definition serves both.

### Q9 — Claude Code reuse boundary
Tinah's "why not use Claude Code's tools," made precise via the harness research.

**Recommended:** Borrow four mechanisms now; defer the rest with named revival triggers; reimplement file tools rather than extracting them.

**Answer:** **Adopted as recommended.**
- **Borrow for v1:** (1) bounded tool results + artifact offloading (size cap per tool; oversized output → file on disk, model sees preview + path); (2) append-only JSONL transcript per session (audit provenance + failure debugging); (3) stable prompt prefix (system prompt + tool defs never vary across turns → prompt caching hits); (4) completion as policy (no-tool_use end + max-turns + token-budget guards).
- **Defer with triggers:** compaction/summarization (trigger: a task actually exhausts context); subagents/parallel workers (trigger: post-baseline harness engineering phase).
- **File tools** (`read_file`, `write_file`, `grep`, `bash`): borrow Claude Code's shapes — names, schema style, result conventions the model knows from training — but minimal own implementations over Node APIs, wrapped in the same size-cap layer as everything else.

### Q10 — Model strategy
**Recommended:** `claude-opus-5` default (accuracy is priority #1), model as config in the `deps` bundle, prompt caching + streaming from day one.

**Answer:** **`claude-sonnet-5` as the default model** — rationale: Andera runs on a Sonnet-tier model in production (~4.6), so building and evaluating against Sonnet matches the deployment reality (and current Sonnet 5 pricing is $3/$15, intro $2/$10 through 2026-08-31). Model stays a config value in `deps` so an Opus comparison is a one-line experiment. Kept from the recommendation: **prompt caching from day one** (`cache_control` on system prompt + tool defs; assert `cache_read_input_tokens > 0` in traces), **streaming always**, adaptive thinking at default, effort at default. **Spend:** be sensible; a hard constraint may come later — no budget mechanism built now.

### Q11 — Page representation (what the model sees)
**Recommended:** Hybrid, text-first — compact semantic outline as the default tool result; screenshots as a separate on-demand tool; raw HTML never in context.

**Answer:** **Adopted.** `inspect_page` returns a compact semantic outline distilled from the accessibility tree — interactive elements with stable ref IDs, headings, visible text (Playwright's ARIA snapshot as the v1 implementation). `click`/`type` take element refs, not coordinates. `screenshot` remains its own tool — needed both for the model's visual verification and because screenshots are the evidence deliverable on several tasks. Raw HTML is never consumed directly into context; if page source is needed it goes to disk and is read selectively via `read_file`/`grep` (Q9 offloading). Known risk: outline quality is the likely top failure source — treat outline improvements as the first general mechanism to tune when evals fail (per Q3's no-overfitting rule).

### Q12 — Evidence outputs: per-run directory + manifest
**Recommended:** Per-run directory + invisible manifest plumbing.

**Answer:** **Adopted.** Every task run gets `runs/<run-id>/` containing: the deliverables, the JSONL transcript (Q9), and an automatically-written `manifest.json` — task text, start/end timestamps, and per artifact: filename, SHA-256 fingerprint (tamper-evidence), source URL, capture time. Implementation: a `writeArtifact` helper that every file-producing tool routes through; manifest-writing is invisible plumbing — the model never manages it, no prompt burden. The manifest doubles as the eval harness's assertion surface (existence, row counts, hash stability) and as the provenance story for the design doc's audit/auth section (Q7).

### Q13 — Eval oracles
**Recommended:** Three tiers, assigned per task; grader reads only the run directory (manifest + artifacts), never the conversation.

**Answer:** **Adopted, plus a standing human overlay.**
- **Tier A — independent API oracle at grading time** (churn-tolerant assertions, e.g. ≥4/5 titles match): HN (Firebase API), EDGAR, GitHub PRs + contributors (REST API), Wikipedia refs.
- **Tier B — structural assertions** (columns, counts, date windows, URL patterns/resolution, internal consistency): X, Airbnb, YC founders, sororities, company-screenshot CSV parts.
- **Tier C — manual grading** for screenshot contents; LLM-judge (vision + rubric) is the deferred upgrade, trigger: manual grading becomes the bottleneck.
- Build order: Tier A oracles for the 3 easy baselines first (HN, EDGAR, OpenClaw PR); the rest as tasks come into scope.
- **Human overlay:** independent of the automated tiers, runs get manually inspected end-to-end — the user watches/reviews with their own eyes to build justified confidence. Automated assertions are the record; human inspection is the sanity check on the assertions themselves.

### Q14 — Tracing platform
**Recommended (initially):** Braintrust via one-line `wrapAnthropic`; revised after fact-check of free-tier limits.

**Answer:** **Langfuse, from day one** (cloud free tier). Deciding fact: the platforms meter on opposite dimensions — Braintrust Starter caps at 1 GB *processed bytes* while Langfuse Hobby caps at 50k *event units*/month. Browser-agent traces are byte-heavy (full conversation with page outlines re-logged each turn ≈ 1–3 MB/run) but event-light (~25–50 units/run): 300–500 dev+eval runs could plausibly exhaust Braintrust's 1 GB mid-trial, but only reach ~half of Langfuse's unit cap. Cost of the choice: OTel-based setup (~1–2h: `@langfuse/tracing` + `@langfuse/otel` + OTel node SDK + Anthropic instrumentation) at the `deps.callModel` seam, vs. Braintrust's one-line wrap. Safety nets: JSONL transcript + `metrics.json` in the run directory remain the durable local record regardless of platform; Langfuse is self-hostable if the cloud tier is ever outgrown. Traces (not just metrics) are required from day one — they're the tool for improving the harness.

## Round 3

### Q15 — v1 tool registry
**Recommended:** Nine tools, no `bash`.

**Answer:** **Adopted — no bash tool in v1.** Registry: `navigate`, `inspect_page`, `click`, `type`, `screenshot`, `download`, `read_file`, `write_file`, `grep`. Every visible eval is covered by these nine. Rationale for excluding bash: it's the only unbounded tool (arbitrary shell driven by model output that reads untrusted web pages — prompt-injection → shell), and "the agent cannot execute arbitrary commands" strengthens the audit security story. All tool inputs zod-validated; file paths confined to the run directory. Revival trigger: a real task the tools can't express — and then added gated behind a command allowlist, not raw shell.

**Amendment (2026-08-10, post-session):** `scroll` added as a **tenth tool** during design-doc revision. Lazy-loading targets (the X feed, Airbnb's listing grid, YC's company list) only create DOM content when scrolling triggers it — no other tool can cause that load, so those tasks were structurally impossible with nine. Not needed for actions (Playwright auto-scrolls refs into view for `click`/`type`); classified state-changing, so the scheduler always serializes it.

### Q16 — Browser state between task runs
**Recommended:** Fresh page per run, one long-lived browser with the persistent profile.

**Answer:** **Adopted.** Chrome launches once per session with the persistent profile (logins stay warm); each task run opens a fresh tab and closes it on completion — page-level state can't leak between trials. Known limitation, accepted for v1: tabs share cookies/localStorage through the profile (e.g. Airbnb "recently viewed" accumulates), which mirrors a real auditor's browser and fits the detection posture; eval assertions must not depend on cookie-derived state. Deferred: full per-run context isolation — trigger: cookie contamination observed to change results between trials.

---

## Session summary — the settled design

**Frontier empty as of 2026-08-10.** Sixteen decisions across three rounds:

**Scope & success (R1):** Minimal hand-rolled agent first (Tinah's challenge answered in the design doc via an alternatives-considered section + borrowed-mechanism list). ~25h remaining; timebox informs ordering, not ambition. Target: all 11 evals with all k=3 trials completing (assertion-based accuracy/completion/consistency). No task-specific logic ever — general mechanisms only. Accounts: X burner, fresh Google, LinkedIn logged-out. Scale: spec'd (worker pool, per-site serialization, cap-is-config), nothing built; sequential eval runs. Interface: Claude Code–style interactive terminal REPL, thin v1, written spec for interface + auth story.

**Architecture (R2):** TypeScript + zod. Borrow from Claude Code: bounded results + artifact offloading, append-only JSONL transcript, stable prompt prefix, completion-as-policy; defer compaction/subagents with named triggers; own minimal file-tool implementations. Model: `claude-sonnet-5` (Andera runs Sonnet-tier) as config in `deps`; prompt caching verified via traces; streaming; sensible spend. Page representation: compact accessibility-tree outline with element refs (Playwright ARIA snapshot), screenshots as separate tool, raw HTML never in context. Outputs: `runs/<run-id>/` with deliverables + transcript + auto-written manifest (SHA-256, source URL, timestamps) via invisible `writeArtifact` plumbing. Evals: 3-tier oracles (API-at-grading-time / structural / manual) + standing human inspection; grader reads only the run directory. Tracing: Langfuse from day one (unit-based free tier fits byte-heavy traces) at the `deps.callModel` seam; transcript + metrics.json as local truth.

**Tools & browser (R3):** Ten tools (`scroll` added in the post-session amendment to Q15), no bash (revival trigger: task the tools can't express; then allowlist-gated). Fresh page per run in one long-lived persistent-profile Chrome.

**Immediate next steps** (per worklog): scaffold loop + Playwright browser controller → baseline on 3 easy evals (HN, EDGAR, OpenClaw PR) with Tier-A oracles.
