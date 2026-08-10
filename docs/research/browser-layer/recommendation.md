# Browser layer: options and recommendation

Synthesized 2026-08-10 from the five research reports in this directory: [browserbase.md](browserbase.md), [camoufox.md](camoufox.md), [browser-use.md](browser-use.md), [ego-lite.md](ego-lite.md), [adjacent-browser-options.md](adjacent-browser-options.md).

## What we need

The agent loop (see the design doc) needs a browser it can drive through a small set of tools — navigate, inspect page, click, type, screenshot, download — plus file writing for CSVs. Whatever provides that browser has to hold up against what the eval tasks actually involve:

- All eleven tasks target public websites (HN, EDGAR, GitHub, Wikipedia, YC, Airbnb, X, Google) — no enterprise SSO.
- Three of those targets actively resist bots (X, Airbnb, Google Search), so getting blocked is a real risk.
- Two tasks need a logged-in session (reading the X feed; writing to a Google Sheet), so logins have to survive between runs.
- The scored constraints are accuracy, generality, scale, consistency between runs, and speed — and token cost matters, especially for tasks we'll run repeatedly.

One thing worth knowing before comparing: these options aren't all competing with each other. Some are browsers, some are libraries for driving browsers, some are complete AI agents, and some are companies that host browsers for you. Every research report reached the same structural conclusion: whichever we use should sit *behind* our tools as a swappable adapter, with the agent loop, evidence manifests, and guardrails remaining our own code.

## The options

### Playwright — the browser automation library

Microsoft's open-source library for launching and driving browsers. It's the de facto standard: you write `page.click(...)`, `page.screenshot(...)`, and it does the rest.

**For:** Each of our tools becomes roughly one library call. Free, deterministic, and it handles persistent profiles (so logins stick). Most importantly, the same code later points at almost everything else on this list — the stealth builds expose the same API, and the browser clouds accept it over one connection call — so building on Playwright keeps every future choice open.

**Against:** It's only a library. No hosting, no scale, no stealth — and plain *headless* Playwright is easy for bot defenses to spot. Running many browsers is entirely our problem.

### Browserbase — browsers in the cloud (similar: Browserless, Steel)

Hosted, isolated browser sessions behind an API: recordings, proxies, CAPTCHA solving, stealth fingerprints, and the same Playwright code connects to them.

**For:** No fleet to operate; parallel sessions on demand; session recordings that double as audit evidence; per-client isolation (one browser per VM). When the agent eventually runs on cloud servers, this is the fix for the "datacenter browser looks like a bot" problem.

**Against:** Everything it's good at is a problem we don't have yet — eleven eval tasks on one machine need no fleet. Per-session billing minimums and cold starts slow down the debug loop. Concurrency is capped by plan (3 free / 25 / 100 / 250+ custom), and the best stealth features sit in top tiers. And counterintuitively, from this Mac it's a *downgrade* in detection posture: a datacenter IP with simulated identity versus our real residential IP and real profile. Browserless and Steel are close competitors (both with self-hosting stories) worth comparing when the cloud stage arrives.

### Browser Use — a ready-made browser agent

An open-source framework that runs the entire agent: give it a task and an LLM, and it observes pages, decides actions, and executes them.

**For:** The fastest path to a demo, with a large community and decent out-of-the-box generalization.

**Against:** It *is* the agent loop — adopting it means outsourcing the part of this project being evaluated. Its prompt assembly is internal, so we lose control of prompt caching; guardrails and evidence policy would be enforced from outside, blind; and its per-step LLM calls cost tokens and reduce run-to-run reproducibility.

### Stagehand — AI browser actions with caching (from Browserbase)

A library on top of Playwright adding LLM-powered primitives — `act("click the login button")`, `extract(...)` — with one standout feature: it caches action results (to disk, or server-side) so repeated runs replay without any LLM calls or token cost.

**For:** That caching is exactly the economics we want for frequently repeated checks — model pays once, replays are free. It works against local browsers too, not just Browserbase.

**Against:** Same loop-ownership concern as Browser Use if used as the orchestrator. Cache keys include the URL and a snapshot of the page, so highly dynamic pages (the X feed, Airbnb results) miss the cache often. And LLM-chosen actions in the main path hurt consistency between runs.

### Patchright and Camoufox — stealth browser builds

Patchright is a community-patched Chromium that hides automation markers; a drop-in Playwright swap. Camoufox is a Firefox fork that spoofs fingerprints at the C++ engine level — the strongest open-source anti-detection available.

**For:** They attack the getting-blocked problem directly, and both speak the Playwright API, so swapping one in is cheap.

**Against:** We don't yet know we need them — that's measurable. Both are community forks that lag upstream and need version pinning. Camoufox specifically is Firefox (some sites behave differently), still in active development, and randomizes fingerprints by default, which works against our consistency requirement unless pinned.

### Ego Lite — an agent-friendly desktop browser

A macOS Chromium app that imports your real browser profile and exposes semantic page snapshots to an agent through a Node runtime.

**For:** Riding a real logged-in session gives a very natural fingerprint, and two of its ideas — compact page snapshots and batching several actions per call — genuinely cut token costs.

**Against:** macOS-only, visible-window-only, no headless or CI mode, weak isolation between tasks, and a young project. It can't be the runtime for something that has to scale — but its two good ideas can be borrowed without adopting it.

## The recommendation

**Playwright driving normal Chrome on this machine — visible window, persistent profile — with the agent loop built by us, as the design doc describes.**

The reasoning, briefly:

- **Simplest tool surface.** One library call per tool, full control over validation, output size, and formatting.
- **Best detection posture available, for free.** Bot detection combines fingerprint, IP reputation, behavior, and session history. A real Chrome with a real logged-in profile on a home IP scores well on all four — better than any datacenter stealth product starts from. (Headless mode is the one thing to avoid: it's the most detectable configuration of all.)
- **Token efficiency stays in our hands.** Owning the loop lets us keep a stable prompt prefix for caching, return compact page outlines instead of raw HTML, batch several deterministic actions per tool call, and record successful runs for cheap replay. None of that is possible inside someone else's loop.
- **Nothing is locked in.** Because the tools are written to the Playwright API, the browser behind them can become a stealth build or a cloud fleet later without touching the loop.

If a site does block us, the sensible response is one step at a time — Patchright first (stays Chromium), Camoufox second (with a pinned fingerprint), paid stealth services last — each step taken only on an observed block, not preemptively. To make those calls with data rather than guesses, it's worth wiring a Browserbase connection into the adapter early (an API key and one connect call) and measuring block rates on X, Airbnb, and Google both locally and hosted.

Early proof points worth building toward: every artifact hashed and listed in a manifest, a login that survives a restart, identical outputs across repeated runs of the same task, and those block-rate measurements.

## Changes we're likely to make later

- **Move browsers to Browserbase when we leave this machine.** The moment the agent runs on cloud servers — for always-on scheduled checks, more parallelism than one machine, or per-client isolation — the detection argument flips (vanilla Chromium on AWS looks bot-like; Browserbase's identity work is the fix) and its recordings become useful audit artifacts. The adapter makes this roughly a one-line change.
- **Add action caching for repeated tasks.** Once the same checks run on a schedule, replaying recorded actions instead of re-asking the model is the big cost and consistency win. Whether we build that replay layer ourselves or adopt Stagehand's caching deserves a small head-to-head experiment; the likely production shape is Browserbase plus cached actions.
- **Scale throughput with a queue, not just concurrency.** For bursts like "500 GitHub PR checks," a task queue feeding a modest worker pool beats raw parallelism — any single site's rate limits bind long before browser supply does.
- **Swap in a stealth build per-site if blocks appear** — the escalation path above, driven by measurements.
