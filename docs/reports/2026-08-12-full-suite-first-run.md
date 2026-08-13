# First full-suite eval run — all 11 tasks, k=3

**Date:** 2026-08-12 (evening)
**Model:** claude-sonnet-5 · tool profile `atomic` · concurrency 3 (headless isolated) + serial headed lane for authenticated tasks
**Commits under test:** `c9c7e69` (batch 1), `5d1217e` (batch 2 — runner resilience, harness-only change; the agent under test is identical)
**Results:** `evals/experiments/2026-08-12_05-43-30pm_eval-mit-sororities-openclaw-merged-prs_9d69b4.json` (batch 2) + preserved partial grades from batch 1 (elon_tweets, airbnb_lake_tahoe)

This is the first run covering every implemented dataset — all 11 rows of
`evals/evidence-collection-project-evals.csv` — and the first real exercise of the
parallel headless eval infrastructure merged this morning. Headline: **5/11 task
passes, 20/33 trials fully complete, overall assertion accuracy 88.7% on trials
that ran to a grade.** Every failure has a concrete, categorized cause below; none
of them is artifact shadowing, steering, or provenance related — the scratch/artifacts
contract held everywhere.

## Two harness fixes were needed to get the run done

1. `about:blank` **start URLs crashed CLI trials** (`c9c7e69`). The two "Blank Tab"
  tasks (`company_freshness`, `stub`) navigate nowhere; the TUI path filtered this,
   the CLI path did not. `usableStartUrl` now lives in `runTask` and the CLI runner
   uses it. Without this fix company_freshness would have been 0/3 on startup crashes;
   with it, 3/3.
2. **A throwing trial killed the whole batch** (`5d1217e`). Batch 1 died 6 trials in
  when one mit_sororities trial exhausted its stream retries; 27 pending trials were
   discarded (the 6 finished grades survived via the partial JSONL). The runner now
   records a trial error as a failed trial (`error` on the grade, zero accuracy, task
   FAIL) and continues; only explicit cancellation aborts a batch. Batch 2 validated
   this live: four trials errored, twenty-three others were unaffected.



## Results by task


| Task                  | Difficulty | Completion   | Accuracy | Mean latency | Mean cost/trial | Verdict                      |
| --------------------- | ---------- | ------------ | -------- | ------------ | --------------- | ---------------------------- |
| hacker_news           | Easy       | 3/3 **PASS** | 100%     | 24s          | $0.07           | saturated                    |
| edgar                 | Easy       | 0/3 FAIL     | 22.2%    | 218s         | $0.77           | infra: SEC bot-block         |
| openclaw_pr           | Easy       | 3/3 **PASS** | 100%     | 63s          | $0.15           | saturated                    |
| company_freshness     | Medium     | 3/3 **PASS** | 100%     | 120s         | $0.94           | first CLI pass               |
| yc_w24_outreach       | Medium     | 0/3 FAIL     | 75.0%    | 102s         | $0.71           | capability: research quality |
| openclaw_merged_prs   | Medium     | 1/3 FAIL     | 91.7%    | 183s         | $2.02           | ambiguity: bot committer     |
| elon_tweets           | Medium     | 2/3 FAIL     | 95.2%    | 69s          | $0.34           | suspected grader bug         |
| openclaw_contributors | Medium     | 3/3 **PASS** | 100%     | 254s         | $3.54           | second consecutive pass      |
| wikipedia_reference   | Hard       | 2/3 FAIL     | 91.7%    | 115s         | $0.49           | capability: extraction depth |
| airbnb_lake_tahoe     | Hard       | 3/3 **PASS** | 100%     | 235s         | $2.62           | first-ever run: pass         |
| mit_sororities        | Hard       | 0/3 FAIL     | 0%       | 649s         | $4.04 (sunk)    | infra: stream truncation     |


Spend: **$60.26 total** ($24.94 batch 1 + $35.32 batch 2), of which **$28.20 was
consumed by the six mit_sororities trials that errored** (three unrecorded in batch 1's
crash, three recorded in batch 2). Productive spend ≈ $32 for 27 graded trials.
Wall clock: batch 2 ran 27 trials in 30 minutes; the suite minus mit_sororities is
fast (hard-task trials 2–7 min each, easies under 1 min).

## Failure modes, ranked by priority



### 1. Stream truncation at deep context kills long trials (infrastructure, P0)

`mit_sororities` errored **6 of 6 attempts** across both batches with the same
signature: at turn 90–160 and 170k–230k tokens of context, a long `write_file`
response stream ends with unterminated content blocks; four retries (0.9s→4.8s
backoff) all truncate; the trial dies. It never failed on shallower tasks — the
deepest surviving trial (contributors, ~100 turns / ~130k) sits just below where
mit_sororities operates. The three concurrent copies of the task made each other
worse: batch 1 shows all three retrying truncated streams within the same minute.

This is the single biggest blocker: the suite's longest task cannot currently
produce a grade at all, and each attempt costs ~$4.70 before dying.

**Diagnosed 2026-08-12 evening** (instrumented `TruncatedStreamError`, commits
`72f99f4`/`4b73864`; one instrumented trial + a minimal-context replay probe):

- Every truncation ends with a **real `message_stop` event** at a stream age of
**55–60 seconds** — the server ends the message deliberately; this is not a
dropped connection.
- The stream is essentially **stalled, not slow**: ~17–21 events and only
~150–800 chars arrive over that minute, always halting at the same position —
the first ~46 chars of the `write_file` input JSON, i.e. the instant the file
*content* value begins generating.
- **Content is exonerated**: replaying the identical 13.6k-char payload in a
~4k-token request completed 3/3 at normal token rates (`stop_reason tool_use`).
- **Context depth is the variable**: the stall only ever occurs at 170k–230k
tokens. The deepest surviving task (contributors, ~130k) never hit it.

Diagnosis: at deep context, generation of a long tool-input value stalls at its
start, and a ~60s server-side watchdog then ends the message cleanly with the
block unterminated. Retries are probabilistic — one instrumented turn recovered
on attempt 4, the next turn exhausted all 4 and killed the trial.

Remedies, reordered by what the diagnosis supports:

- **Context reduction for long tasks** (the real fix): the correlate is context
depth, and mit_sororities is the only task operating in the stall regime.
Cheaper repeat-page representation was already the remedy of record for context
growth; this gives it a hard motivation.
- **Patient retries are now rational insurance**: each attempt costs ~60s and
~$0.10 (cached input), success is genuinely probabilistic per attempt, so
raising the attempt ceiling for this error class buys real survival probability.
- **Report upstream**: the signature (deep-context request, tool-input stream
stalls at value start, clean `message_stop` at ~60s) is reproducible and looks
like a service-side defect worth filing with Anthropic.
- **Append-mode `write_file` is demoted**: the stall happens at the *start* of
the content value, so chunking the write does not clearly dodge it.



### 2. Bot-detection blocks headless isolated browsers (infrastructure, P0 for affected sites)

`edgar` went 0/3: two trials spent their entire runs (102 and 60 turns) locked out
by SEC.gov's "Undeclared Automated Tool" / "Request Rate Threshold Exceeded" pages —
every path (search UI, browse-edgar, data.sec.gov JSON, archives) returned 403 — and
the third trial errored on a 30s `page.goto` timeout to the same site. The same task
passed 3/3 on 2026-08-11 **when evals ran through the headed persistent profile**.
The new headless temp-profile browsers, three at once from one IP, trip SEC's
automated-traffic defenses.

The agent's behavior under the block was exactly right: exhaustive alternatives, an
honest answer.md declaring the task incomplete, and a screenshot of the block page
published as evidence.

Candidate remedies:

- **Per-task browser policy metadata**: the eval infrastructure already has two
lanes; let task.json opt into the headed persistent lane for bot-sensitive sites
(edgar today; airbnb and x.com are plausible future members). Cost: those trials
serialize.
- Alternatively, humanize the headless fingerprint (UA, `AutomationControlled`
blink feature) and stagger same-site trials. Less certain against SEC.



### 3. Entity-research quality on yc_w24_outreach (capability, P1)

0/3 completions but 75% accuracy — the deliverable structure is always right; the
misses are research depth:

- **Guessed LinkedIn URLs**: `linkedin.com/in/sacellarius`, `/in/binw` — pattern-shaped
slugs the agent never verified (trials 2, 3).
- **Incomplete founder enumeration**: trial 3 selected Artisan but omitted co-founder
Rupert Dodkins, which the task text explicitly requires ("one row for every founder").
- **Company-selection window** (partly ambiguity): trial 1 chose Reprompt, whose
founders aren't in the oracle's YC-AI-tagged set. "AI-focused" per the agent's
judgment vs YC's official tag — defensible, but it costs two founder-match
assertions. Worth a task-text clarification ("companies YC tags as AI").
- One email flagged as insufficiently company-specific (trial 1, row 7).

The actionable agent-side iteration: verify a LinkedIn URL resolves to the named
person (or leave the cell empty, which the grader accepts) instead of synthesizing
plausible slugs, and cross-check founder lists against the YC company page before
finalizing.

### 4. Extraction completeness on wikipedia_reference (capability, P2)

2/3. The failing trial returned the short citation ("Beevor 2012, pp. 555–560")
instead of the full highlighted Sources entry the reference resolves to. The two
passing trials show the capability exists; this is a consistency miss on a fiddly
click-through — the agent stopped at the reference text instead of following the
CITEREF anchor to the Sources section.

### 5. Bot-identity ambiguity on openclaw_merged_prs (task/oracle ambiguity, P2 — watch item)

1/3, and both misses are the **same single assertion on the same PR**: the agent
recorded `ampagent` as committer of #122867; the oracle wants the PR author
`steipete`. This is the same class as the contributors bot question logged
yesterday: when an AI agent authors commits on behalf of a human, "who committed"
is genuinely ambiguous. The agent read the commits tab literally (defensible); the
oracle equates committer with PR author. One trial resolved it the oracle's way, so
it's also nondeterministic. Task-text or oracle clarification territory — I'd let
the oracle accept either identity for bot-authored commits.

### 6. Suspected grader bug on elon_tweets time format (grader defect, P2)

2/3, and the failing assertion rejects every row of a CSV whose cells read
`8:41 AM · Aug 12, 2026` … `accepted date(s): 2026-08-12` — the dates match what
the grader says it accepts, so the parser most likely chokes on the `H:MM AM · Mon D, YYYY`
format rather than the data being wrong. Needs a look at the grader's time parsing;
if confirmed, elon_tweets was functionally 3/3 (and the headed authenticated lane's
first outing was flawless: logged-in x.com, 10–24 turns, $0.18–0.55/trial).

## What worked

- **The scratch/artifacts contract, suite-wide.** Zero steering errors, zero
shadowing incidents, correct roles everywhere sampled (evidence screenshots
role-tagged, deliverables as requested_output, blocked-page evidence on edgar).
- **The two-lane browser runtime.** Headless pool + serial headed lane ran
4-concurrent without profile conflicts; authenticated x.com trials worked
end to end on the first try.
- **Failure honesty.** The blocked edgar trials produced explicit "task not
completed" answers with evidence, not fabricated filings.
- **airbnb_lake_tahoe passed 3/3 on its first-ever run** — 30 listings enumerated,
dates correct, per-listing summaries — the hardest browsing task in the suite.
- **Crash insurance + resilience.** The partial JSONL saved batch 1's grades; the
runner fix turned batch 2's four errors into recorded data instead of a third
relaunch.

