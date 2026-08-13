# Inspect-page elision: keep deep runs out of the decode-stall regime

**Status: IMPLEMENTED (`d3a8f4b` elision, `c2e8c80` cache frontier,
`d14ddf9` truncation retries 4→8) — round-2 validation in flight.** Decided
2026-08-12 evening after the truncation diagnosis (see
`docs/reports/2026-08-12-full-suite-first-run.md`, failure mode 1, and
commits `72f99f4`/`4b73864` for the diagnostics).

## Validation round 1 (on `d3a8f4b`, 2026-08-12 evening)

- **contributors k=1 regression: PASS twice** (7/7 both runs; peak context
  62,134 vs ~130k before — target met; second run on `c2e8c80`).
- **mit_sororities k=3: FAIL 0/3 — the context goal was met and the stall
  happened anyway.** Trials ran 2–3× deeper than ever (turns 166/168/207 vs
  dying at 90–160), peak contexts 87k/101k/90k — all under 140k — and every
  trial still died on the same signature: write_file input stalled at 46
  chars, ~60s stream age, clean message_stop, now labeled **stop_reason
  max_tokens** (the model burns its whole output budget delivering ~100
  chars). Four stall episodes in the batch; one survived on its 5th
  attempt, three exhausted the 4-attempt ceiling (~6% per-attempt success).
  **Conclusion: the stall is not a >170k-context phenomenon — context
  reduction moved the onset much deeper into the run but does not clear
  it.** Hence `d14ddf9`: TruncatedStreamError now gets 8 attempts (other
  transients keep 4).

## Validation round 2 (on `d14ddf9`) — inconclusive: credits ran out

- Trials 1–2 died at ~13 min to a 400 billing error (**API credit balance
  exhausted mid-batch**), both mid-stall-retry at attempts 2–3 — the
  8-attempt ceiling never got a fair test.
- Trial 3 produced **the first mit grade ever (3/7)** but for an unrelated
  reason: Google blocked every search with reCAPTCHA ("unusual traffic" on
  12+ queries), so the agent honestly declared the task incomplete and
  shipped an empty CSV at turn 103 / 52k context. That is failure mode 2
  (bot-detection vs headless isolated browsers) reaching mit via Google —
  more weight for the per-task headed-lane item.

## Revision: chunking un-demoted (`67c4941`)

"NOT append-mode" below is superseded. The demotion assumed the stall
trigger is positional (value start); round-1 data says it is the intended
value LENGTH × context: across all three failed trials every *completed*
write was ≤2,657 chars — dozens of them at the same turn depths (150–207)
that killed the big writes — and the only payload ever recovered from a
stall was 13.6k chars. Contributors, which never writes large values,
has never stalled at any depth. `write_file` now takes `append: true`
(manifest hash always covers the whole file) and the system prompt steers
files over ~3,000 chars into pieces.

## Validation round 3 (on `67c4941`+`23f5ce6`) — STALL ELIMINATED

mit_sororities k=3, 2026-08-12 late evening: **3/3 trials graded (5/7,
5/7, 4/7 — 66.7% accuracy), zero truncated streams across ~600 turns** —
the workload that had died 10-for-10. Trials ran 160/218/222 turns, peak
contexts 109k/132k/~120k. The model obeyed the chunking guidance
throughout: every write_file piece in every trial was ≤3,103 chars,
with append used for larger files. The 8-attempt retry ceiling was never
needed.

**Verdict: the infrastructure failure mode is closed.** The stack that
did it: elision (context stays ~60% lower), chunked writes (removes the
large-single-value trigger entirely), patient retries (unused backstop).

Remaining mit failures are a different story:
- **Google Sheets URL (0/3, likely structural):** the task requires
  publishing a Google Sheet; headless isolated browsers have no Google
  account. Candidate: per-task headed-lane opt-in (same as edgar /
  failure mode 2).
- **Cohort coverage/format (capability):** trial 2 collected all 182
  members but wrote affiliations as "Alpha Chi Omega (MIT)" — unrequested
  decoration the grader rightly rejects (exact-structure rule). Trials 1
  and 3 each missed the same 3 cohorts (Alpha Chi Omega '26, Pi Beta Phi
  '26/'27).

**Discovery during validation — the cache-prefix argument below was wrong.**
The server matches cached prefixes only ~20 content blocks back from a
cache_control marker. A displacement turn's request diverges at the newly
stubbed message — usually far more than 20 blocks before the tip marker —
so all 28 displacement turns of the contributors run missed the *entire*
messages region and re-paid it at write rates (1.07M cache-write tokens on
a 62k-context run, ~$4 of a ~$4.90 trial). Fixed in `c2e8c80`: a second
moving breakpoint rides the elision frontier (the newest stub), so
displacement turns resume from the previous frontier's entry. Validated:
misses fell to 6 (all during the first displacements, before a frontier
entry exists) and cache writes halved. **Lesson for any future message-view
rewriting: a mid-conversation edit needs its own moving breakpoint.**

## Problem

At 170k–230k tokens of context, the model's generation of long `write_file`
inputs stalls at the start of the content value and Anthropic's server ends the
message with a clean `message_stop` at ~60s, leaving the block unterminated
(`TruncatedStreamError`). mit_sororities died 7/7 attempts. Content and
connection are exonerated (the identical 13.6k-char payload streams 3/3 at 4k
context); context depth is the variable. The context balloons because every
`inspect_page` result stays in the conversation forever — the deepest task
carries ~50+ stale page dumps.

## The fix (user-specified)

1. **Before each model call, keep only the last 2 `inspect_page` tool results
   in the prompt.** Replace older ones with a short stub: URL/title plus
   "re-inspect if needed".
2. **Transform the API message view only — never rewrite the run transcript on
   disk.** The transcript keeps recording what actually happened; grading and
   provenance are untouched.
3. **Teach the model with one prompt line**: lasting facts belong in `scratch/`
   / `artifacts/` files; page references come from the latest kept inspects.
4. **The existing 50KB tool-output offload stays as-is** — it caps what enters
   the conversation but never shrinks what accumulated; it does not solve this.

**Goal:** deep tasks like mit_sororities stay under ~140k tokens — comfortably
below the observed stall floor (~170k) and below the deepest known-good run
(contributors, ~130k).

## Implementation notes for the next session

- The transformation belongs at the message-assembly seam right before
  `callModel` in the agent loop (`src/loop/`), operating on the outgoing
  message array each turn.
- Stubs must keep the `tool_result` structure valid (same `tool_use_id`,
  same role placement) — only the content is replaced.
- Prompt-cache behavior is acceptable by construction: the already-stubbed
  early region stays byte-identical turn over turn (cache prefix preserved);
  each new inspect_page stubs the third-most-recent one, invalidating cache
  only from that recent point forward.
- Elide `inspect_page` only (the whales). Screenshots return paths, not
  pixels; other tool results are small or already offloaded.
- Expected side benefit: deep-trial cost roughly halves (mit trials were
  $4–6, dominated by 10–18M cache-read tokens).

## Validation

- Unit tests on the message-view transformation (keeps last 2, stubs the
  rest, transcript untouched, tool_use_id integrity).
- `mit_sororities --k 3`: expect grades instead of TruncatedStreamError, and
  peak context under ~140k (check metrics.json / usage lines).
- `openclaw_contributors --k 1` regression: deep-task accuracy must not drop
  from losing old page context (it re-inspects or reads its scratch notes).

## Related, deliberately separate

- Retry ceiling bump for `TruncatedStreamError` (4 → 8) as insurance — cheap,
  independent commit.
- File the stall signature upstream with Anthropic.
- NOT doing: append-mode `write_file` (stall is at the content's first token;
  chunking doesn't dodge it).
