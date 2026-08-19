# Narrow evidence judge changes

**Status:** Implemented 2026-08-17. The first live-eval follow-up is tracked in
[research-persistence-follow-up.md](research-persistence-follow-up.md).

## Goal

Make Sherlock feel like a capable human assistant while retaining v3's
durability and evidence guarantees. The worker should be able to explain what
it accomplished and any obstacle it encountered. The judge should answer one
narrow question:

> Do the surfaced artifacts and evidence support that the explicit user
> request was fulfilled without the worker materially overstating its work?

The judge is not a general second agent, a style critic, an oracle, or a source
of additional task requirements.

## Intended terminal flow

```text
worker researches and publishes
  -> worker calls finish with a human summary and unresolved requirements
  -> deterministic structural checks produce settled facts/findings
  -> fresh read-only judge returns verified, needs_correction, or incomplete
  -> needs_correction returns actionable feedback to the same worker session
  -> verified or incomplete publishes the worker's latest summary to the user
     alongside the manifest-derived artifact list
```

There is no correction-specific attempt cap. Existing whole-run safety budgets
remain the final bound.

## Change list

### 1. Thin the initializer contract

- Keep only requirements explicitly grounded in the user's request:
  requested artifacts, formats, exact columns and ordering, explicit counts,
  requested scope, and evidence requirements.
- Preserve exact constraints stated by the user.
- Do not invent expected values, entity lists, availability assumptions,
  domain heuristics, or requirements that merely seem desirable.
- Represent requested scope as a condition for the judge to assess, not as a
  deterministic rule that makes truthful incompleteness impossible.
- Treat the original user request as authoritative if it conflicts with the
  initializer's normalization.

### 2. Narrow deterministic completion checks

- Keep objective checks for manifest integrity, hashes, publication roles,
  file existence, safe paths, parseability, exact requested shapes, column
  order, and explicit mechanical counts.
- Remove inferred semantic assertions such as guessed expected-value sets,
  identity heuristics, and other domain-specific notions of completeness.
- Produce settled facts and concrete structural findings for the judge rather
  than deciding broad semantic completion in code.
- When the worker reports unresolved requirements, allow the judge to see the
  structural findings instead of trapping the run in a pre-verifier repair
  loop.

### 3. Change the model-facing `finish` handoff

Use one strict completion report:

```json
{
  "summary": "Human-facing account of what was accomplished and any material obstacle.",
  "unresolved": [
    {
      "requirement": "The specific unresolved part of the request",
      "reason": "Why it could not be completed",
      "attempts": [
        "A source or approach already tried"
      ]
    }
  ]
}
```

- `unresolved: []` means the worker believes the request is complete.
- A nonempty list submits useful partial work and asks the judge to assess the
  blockers.
- `summary` is the worker-authored response intended for the user after the
  terminal decision.
- `attempts` helps the judge avoid recommending work already tried.
- Bound all strings and list sizes in the schema.
- Do not include `artifact_paths`; requested outputs and evidence come only
  from the authoritative manifest.
- Do not restore the retired free-form `limitations` field.
- Validate `unresolved` structurally only. Do not scan its prose for words or
  treat it as evidence.

### 4. Enforce a narrow judge evidence diet

The judge may receive only:

- the original user request;
- the thin, task-derived contract;
- published manifest entries with `requested_output` and/or `evidence` roles;
- the contents or bounded inspection facts for those surfaced files;
- manifest provenance and hashes;
- deterministic settled facts and findings; and
- the worker's completion report, explicitly labeled as an untrusted claim.

The judge must not receive or inspect:

- scratch files;
- the worker transcript or hidden reasoning;
- unpublished browser observations or tool results;
- internal recovery/checkpoint files;
- eval oracle data; or
- grader expectations.

Enforce this boundary in the verifier registry/path policy, not only in prompt
text.

### 5. Give the judge a narrow decision rubric

The judge evaluates each explicit requirement as:

```text
explicit requirement -> surfaced evidence -> supported or unsupported
```

`verified` requires all of the following:

- objective checks passed;
- every material explicit requirement is supported by surfaced outputs and
  evidence;
- the worker's summary faithfully describes the surfaced work;
- the worker does not materially overclaim; and
- no material requirement remains unresolved.

The judge must not evaluate:

- aesthetic optimality or preferred writing style;
- whether the worker could have collected optional extra information;
- requirements the user did not state;
- guessed expected values or external identity heuristics;
- speculative alternative research strategies;
- scratch work or unpublished claims; or
- mechanical properties already settled by deterministic code.

This is a judge of evidence-backed completion, not an omniscient factual
oracle. External eval graders remain responsible for comparison with hidden
ground truth.

### 6. Add three typed judge outcomes

- `verified`: every material explicit condition is supported.
- `needs_correction`: a concrete, reasonable next action could resolve a
  specific unsupported condition.
- `incomplete`: a material condition remains unsupported, the reported
  blocker is credible enough to stop without claiming success, and another
  equivalent retry is unlikely to help.

Every finding must identify the explicit requirement it concerns. A
`needs_correction` finding must state the observed problem and a concrete next
action. Generic criticism such as "be more comprehensive" is invalid.

The worker's `unresolved` entries and `attempts` inform whether another action
is useful, but never prove completion.

### 7. Preserve useful worker-judge dialogue

- Return `needs_correction` feedback to the same persistent worker session.
- Keep prior judge findings and the worker's attempted approaches visible so
  each cycle can make progress.
- Let the worker research further, modify artifacts, and submit an updated
  `summary` and `unresolved` list.
- Do not add a fixed one-correction or correction-loop cap.
- If no new evidence appears and the same credible blocker remains, the judge
  should return `incomplete` rather than repeat identical advice.
- If the worker claimed completion but the judge identifies a non-repairable
  blocker, first ask the worker to make its completion report truthful. A
  normal terminal `incomplete` result should carry a worker-written summary
  that accurately describes the partial result.

### 8. Preserve verified-run presentation

- Keep the existing successful behavior: the final accepted `finish.summary`
  becomes `finalText` and is released only after judge acceptance.
- Do not add a post-verification model call.
- Let the harness add only deterministic presentation such as status, timing,
  run location, and manifest-derived artifact rows.

### 9. Make incomplete runs human-facing

- Preserve and display the worker's latest `finish.summary` for a terminal
  incomplete run.
- Display all successfully published manifest artifacts.
- Present a concise incomplete status and unresolved requirements without
  replacing the assistant's response with an internal reason code.
- Keep coordinator reason codes, detailed attempts, and diagnostics in run
  metadata or an optional detail view.
- Update both TUI and REPL/public adapters; the current public result retains
  incomplete `finalText`, but interactive rendering largely drops it.
- If a run ends before any completion report exists, use a short deterministic
  fallback stating that the assistant stopped before it could prepare a final
  response, and still show any surviving artifacts. Do not fabricate a
  worker-authored explanation.

### 10. Keep each judge pass focused and bounded

- Start each pass fresh and read-only.
- Provide the task, thin contract, completion report, manifest, deterministic
  facts/findings, and bounded surfaced-file inspection.
- End every pass with exactly one typed decision.
- Retain bounded evidence inspection where necessary; do not turn the judge
  into a second browsing or research agent.

### 11. Simplify model-facing instructions

- Remove policy explanations already enforced by code.
- Retain concise guidance for batched browser programs, evidence publication,
  truthful blocker reporting, and the completion handoff.
- Explain that `finish` requests review and cannot declare success by itself.

## Explicit non-goals

- No fixed correction-loop cap.
- No post-verification worker-response call.
- No worker-supplied artifact list in `finish`.
- No return of the old `limitations` field.
- No automatic verification of partial work.
- No separate `blocked`, `stop`, or second completion tool.
- No new verifier model, browser access, or broader verifier toolset.
- No removal of the initializer in this change.
- No conditional verifier bypass in this change.
- No weakening of exact output shapes explicitly requested by the user.

## Infrastructure retained unchanged

- The frozen eight-tool worker surface and sequential execution.
- `browser_execute` and its protected parent helper.
- `publish_artifact` as the sole publication boundary.
- Manifest-authoritative output and evidence selection.
- Provenance, hashing, no-follow inspection, and run-directory isolation.
- Cancellation, crash recovery, checkpoints, artifact journals, process
  watchdogs, and browser page ownership.
- The judge as the only authority that can produce a verified outcome.

## Related improvements already complete

- Worker turns are unbounded by default.
- Aggregate model tokens are unbounded by default.
- Cumulative tool-result bytes are a metric rather than a whole-run completion
  ceiling; per-result and per-message bounds remain.
- The old `limitations` input and its problematic prose checks are gone.
- Browser navigation uses bounded useful settling semantics.
- Static worker guidance encourages bounded multi-item browser programs.

## Verification expectations for implementation

- Update existing focused schema, coordinator, verifier, finish-check, TUI,
  REPL, and public-run tests instead of creating broad redundant suites.
- Pin at least these behavioral cases in existing coverage:
  verified complete work; actionable correction followed by verification;
  credible unresolved work ending incomplete with a worker-written response;
  repeated no-progress feedback converging to incomplete; and an involuntary
  stop with no worker completion report using the deterministic fallback.
- Run targeted tests, `npm run typecheck`, `git diff --check`, and the complete
  hermetic suite before declaring the change complete.
- Do not run a live eval re-baseline without explicit user direction.
