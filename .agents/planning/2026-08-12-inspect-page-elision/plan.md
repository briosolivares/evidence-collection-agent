# Inspect-page elision: keep deep runs out of the decode-stall regime

**Status: PLANNED — not implemented.** Decided 2026-08-12 evening after the
truncation diagnosis (see `docs/reports/2026-08-12-full-suite-first-run.md`,
failure mode 1, and commits `72f99f4`/`4b73864` for the diagnostics).

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
