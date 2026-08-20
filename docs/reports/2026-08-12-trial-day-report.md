# Day Report — Evidence Collection Agent

*2026-08-12 (through early 08-13). Written to be read without prior context.*

## TL;DR

- The agent drives a real browser to collect audit evidence; an eval harness grades it against live ground truth.
- **Start of day:** hardest task dead 10-for-10 on an infrastructure failure; 5 of 11 eval tasks passing.
- **End of day:** infrastructure failure eliminated, eval environment fixed to measure the agent (not the harness), **effective 8 of 11 passing**.
- Every remaining failure is named, understood, and mapped to a design change.
- The day's real product: a failure taxonomy and the design decisions it forced.

---

## Failure 1: Deep tasks died mid-write ("the decode stall")

**First, how the agent loop works (one turn):**

1. The harness assembles the **conversation so far** — the task, plus every model message and tool result to date — into one request.
2. It sends that request to the **Anthropic API** (the hosted model). We use streaming: the model's reply arrives token by token over an open connection.
3. The reply is either text (task done) or a **tool call** — e.g. `write_file` with the filename and the full file contents *as part of the model's generated output*.
4. The harness executes the tool locally (writes the file, clicks the button, inspects the page), appends the result to the conversation, and goes back to step 1.

Two things to hold onto: a "file write" means the model must *generate the entire file contents* as output tokens in step 3 — and the conversation in step 1 grows every turn, so deep tasks send a bigger request each time.

**Symptom — the failure lived inside step 3:**

- Mid-reply, while the model was streaming a `write_file` call, the incoming tokens just **stopped** — always exactly 46 characters in, right where the file's contents begin.
- The connection stayed healthy. ~60 seconds later the API ended the reply "normally" — reporting it had generated (and billed us for) its entire 8,192-token output budget, of which we received ~100 characters.
- So: the model was generating full-speed on Anthropic's side, but the file contents never came out. The harness got a half-finished tool call it couldn't execute, retried the turn, and usually stalled again (~6% success per retry).
- The hardest task (~180 sorority members → CSV) died this way **10 times in a row**.
- (Streaming wasn't the cause — a non-streaming request hits the same generation and would return the same truncated reply, just without the diagnostic timeline that cracked the case.)

**Theory #1 — "the request got too big" (step 1) — was wrong, usefully:**

- Every inspected page stayed in the conversation forever, so deep tasks were sending 170k+ tokens per request by the time they died.
- Built **context elision**: only the 2 most recent page inspections stay in what gets sent; older ones collapse to one-line stubs.
- It worked as designed — requests shrank ~60%, cost halved — **and the task still died**. Theory falsified.

**The real cause — the output side (step 3), not the input side:**

- The data showed every *completed* file write was small (≤2.7k chars); only large single writes (13k+) stalled.
- The failure trigger was asking the model to generate **one large uninterrupted value** in its reply — that's what froze, regardless of how small we made the request.
- Fix: **chunked writes** — an `append` mode on the write tool + guidance to build big files in ~3k-char pieces across several turns.
- Result: **zero stalls across ~600 turns**; the impossible task now completes 3-for-3.

**Design decisions:**

- **Transform the model's view, never the record.** Elision rewrites only what's sent to the API each turn; the on-disk transcript keeps everything. Provenance and grading are untouched by context management.
- **The harness must shape tool-call sizes** — unbounded single values inherit the API's fragility.
- **A fix that meets its target but not its goal is a falsified theory** — that's what pointed at the real trigger. (Elision stayed anyway, for the cost win.)

## Failure 2: The environment was failing, and it looked like the agent

**Symptom:**

- SEC's website: 403s for every headless trial (0/3) — but 3/3 in a visible Chrome window.
- Google: CAPTCHAs on headless searches.
- One task needs a Google Sheet published — impossible in a throwaway browser with no account.
- On paper: agent failures. In reality: the agent never got a fair attempt.

**Design decision — tasks declare their browser needs; the eval honors them by default:**

- Three tasks (SEC, X/Twitter, MIT/Google-Sheets) now default to a visible, persistent, logged-in Chrome; everything else stays in the fast parallel headless pool.
- Renamed the flag `requiresAuth` → `headed`: a login is only *one* reason to need a real browser; bot-blocking is another.
- The loader **hard-rejects the old flag name** — a stale config can't silently demote a task to the wrong lane.
- Result: SEC 0/3 → 3/3 immediately; the X task produced its first-ever grades and passed.

**Principle:** an eval should measure the agent's limits, not the harness's.

## Failure 3: When independent trials make the same "mistake," suspect the referee

**The tell:** fresh, independent trials converging on the same "wrong" answer.

**Best example — Reprompt:**

- The YC-founders task kept getting rejected for picking the company Reprompt as a "YC W24 AI company."
- Checked YC's own data: Reprompt **is** W24, one-liner literally "AI Agents for Location" — but its tags array in YC's index is **empty**, and our ground-truth oracle filtered by tags.
- Three trials across two days read the directory correctly and were punished for it.

**Design decisions:**

- **Convergence is an attribution signal:** variance across trials points at the agent; agreement points at the oracle/grader.
- **Fix oracles with data, not exceptions** — classify from the text a reader actually sees, not just metadata.
- **Regrade, don't rerun:** every trial leaves a complete run directory, so grader fixes were validated by regrading old runs at zero API cost. Two tasks flipped to passing without touching the agent.

## Failure 4: The agent's genuine research failure modes

With infrastructure and measurement fixed, four distinct agent-side modes remained:

**4a. Systematic invisibility — the same entities missed every time.**

- Same co-founder missed two days running; same two class cohorts missed two days running.
- Cause: strategy was "collect whatever my searches surface" — some entities never surface on that path.
- **Fix (shipped): enumerate-then-fill.** Find the source that authoritatively lists the entities, write the roster to a checklist file *before* collecting, reconcile against it before finishing.
- First validation: this failure class went to **zero** (small sample, but the exact targeted class).

**4b. Implicit contracts violated at scale.**

- One trial collected all 182 members perfectly — and lost the whole grade for writing "Alpha Chi Omega **(MIT)**": decoration nobody asked for, in a field the grader checks verbatim.
- **Fix (shipped): pin the output contract up front** — exact columns and field rules written to a file before collecting, consulted at write time.

**4c. Unverified load-bearing assumptions.**

- Wikipedia task (find reference #275, reproduce its source): failed 3-for-3 with the *identical* error.
- All three trials jumped to HTML anchor `cite_note-275` and assumed anchor number = displayed number. On Wikipedia it doesn't.
- No trial checked the assumption its entire answer rested on.

**4d. Self-verification is confirmation-shaped** *(the most instructive failure of the day)*:

- After the roster protocol shipped, one trial leaked a stray `</content>` tag (a training-habit artifact) into its CSV.
- The protocol's reconcile step **ran**: the agent re-read the file, grepped for its 11 roster rows, found all 11 — passed itself.
- It never asked the opposite question: *"is everything in this file supposed to be here?"*
- The worker checked its own work and graded itself generously.

**Design decision from 4c + 4d — an independent judge, not more self-check instructions:**

- A **judge subagent**: a fresh-context model call at the end of a run.
- It sees only the task text + the produced artifacts (the same information diet as our graders) and returns a punch list the worker must clear before finishing.
- Core argument: *the entity incentivized to finish should never decide it's finished.*
- Cheap: no browser needed — one extra model call per trial.
- Our eval harness already embodies this separation *around* the agent (graders never see the conversation); this brings the same separation *inside* the run.

**Guardrail:** no protocol may encode a grader's specific checks — that's training to the test. Everything is general research procedure, the kind you'd give a new research assistant on day one.

## Scoreboard

| | Start of day | End of day |
|---|---|---|
| Hardest task (MIT) | dead 10/10 on infra | completes reliably |
| Tasks passing | 5 / 11 | effective 8 / 11 |
| Infra failures | stalls, bot-blocks | zero |
| Remaining failures | undiagnosed | 3, each with a named design path |

**What remains:** the MIT Google-Sheets step (one verified login + a rerun), assumption errors and output slop (the judge subagent), per-row quality drift at scale (also judge territory).

## Transferable principles

1. **Views are not records** — manage context by transforming what the model sees per call; never rewrite what happened.
2. **Measurement validity before capability work** — sort every failure into *environment / referee / agent* first; the first two masqueraded as the third all day.
3. **Convergent failure indicts the oracle; variance indicts the agent.**
4. **Falsified theories are progress** — the wrong theory's fix produced the data that found the right cause.
5. **Self-verification confirms; independent verification checks** — completion judgment belongs to fresh eyes with the evidence.
6. **Durable state over context** — rosters, contracts, and evidence live on disk; the run directory, not the conversation, is the source of truth.
