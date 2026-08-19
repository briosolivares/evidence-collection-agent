# Research persistence and verifier simplification follow-up

**Status:** Implemented 2026-08-18 on `simplify/sherlock-core` (sections 1 and
3-8, plus the local verification in section 9). Section 2's structure-only
splits were deliberately skipped — no behavior change depended on them.
Section 9's live re-evaluation remains open pending explicit user direction.
Amended 2026-08-18 after review: fixed ownership for
enumerated sets (section 3), the verifier sparsity rule (section 5), and the
blocker-credibility ladder, pre-finish coverage self-check, and
attempts-aware convergence (section 6). Also landed alongside: the whole-run
`maxToolCalls` ceiling was lifted to unbounded, so wall time is the run's
bound on research persistence.

## Why this follow-up exists

The first live batch after the narrow surfaced-evidence judge change completed
with these results:

| Task | Grade | Durable outcome |
| --- | ---: | --- |
| Hacker News | 6/6 | verified |
| YC W24 outreach | 8/8 | verified |
| MIT sororities CSV | 4/6 | incomplete (`verifier_unavailable`) |

Report:
`evals/experiments/2026-08-17_10-55-01pm_eval-hacker-news-yc-w24-outreach-mit_bc3e29.json`.

The MIT run missed the required Delta Phi Epsilon 2026 and 2027 cohorts and
fell below the grader's major-information threshold. The live MIT-hosted site
was unavailable, but the important protocol regression happened after the
worker truthfully reported that gap: the judge converted a deterministic
missing-affiliation defect into advice to add an empty/placeholder row. The
worker followed that advice instead of continuing research. A later verifier
response attempted `verified` while unresolved requirements remained, and the
runtime classified the invalid response as `verifier_unavailable`.

The earlier passing MIT run used the same worker model. It initially missed
Delta Phi Epsilon too, but received the raw deterministic rejection, continued
researching, tried alternate schemes and site navigation, and found the live
HTTP roster. This points to completion incentives and site availability, not a
simple model-quality difference.

## Required invariants

- The original user request remains authoritative.
- A missing requirement may produce more research or truthful incompletion;
  it must never produce synthetic records, placeholders, invented identities,
  or weakened requirements.
- Deterministic structural defects remain authoritative and are never
  rewritten by a model into a workaround.
- The verifier judges surfaced evidence. It does not design artifact contents
  or act as a second research agent.
- `verified` is impossible while the worker reports an unresolved material
  requirement.
- A credible, reasonably exhausted blocker ends as
  `verification_incomplete`, with useful partial artifacts preserved.
- Whole-run budgets remain the bound on persistence. No unbounded retry loop
  or task-specific source logic is introduced.

## Simplest target flow

```text
worker calls finish
  -> deterministic checks
       -> failed: return the raw defects to the same worker
       -> passed: run the fresh read-only verifier
            -> verified: terminal success
            -> needs_correction: return a typed research, artifact, or report issue
            -> incomplete: terminal truthful partial result
```

The verifier does not return free-form artifact values or weakening
instructions. Each correction has a typed kind. Harness-owned research
feedback supplies the general fallback policy; an artifact repair must cite
surfaced evidence that already supports the repair, and a report repair may
only make the worker's completion report more truthful.

## Implementation checklist

### 1. Add the regression coverage first

- [x] Reproduce the generic failure shape in existing verifier/coordinator
  tests: an explicit entity is unresolved, a structural finding notes its
  absence, and a proposed placeholder must never reach the worker as an
  acceptable repair.
- [x] Cover an unresolved finish followed by genuinely new research and a
  second finish attempt.
- [x] Cover a credible exhausted blocker ending
  `verification_incomplete` with the worker summary and unresolved details.
- [x] Cover an invalid `verified` verdict while unresolved requirements remain.
- [x] Cover convergence both ways: unchanged surfaced evidence with a
  genuinely new distinct attempt continues for another cycle; unchanged
  evidence with no new distinct attempt converges to incomplete.
- [x] Cover the sparsity rule both ways: a sparse explicitly requested column
  with no unresolved entry and richer official pages in surfaced evidence
  yields a `research` finding; the same sparsity behind a credible unresolved
  entry does not.

### 2. Separate cleanup from behavior changes

Skipped at implementation time (2026-08-18): these are structure-only file
splits with no behavior change, and the behavior changes below landed safely
without them. Revisit only if the files grow past comfortable review size.

- [ ] Split initializer protocol declarations (prompt, schema, tool) from the
  bounded initializer session and worker-facing contract rendering.
- [ ] Split verifier decision types, prompt/opening-context rendering, and the
  model/tool session from the small verifier composition facade.
- [ ] Preserve current public exports while moving responsibilities, then run
  the focused tests before changing protocol behavior.
- [ ] Do not introduce a generic model-loop abstraction unless another real
  caller needs the same lifecycle.

### 3. Remove the contract contradiction first

Ownership is fixed rather than classified per task: the deterministic layer
owns fabrication and shape, the verifier owns scope completeness, and the
worker owns diligence (section 6). No initializer judgment call chooses
between a presence gate and an allowed-values rule.

- [x] In newly initialized contracts, a task-enumerated value set always
  becomes two things: a deterministic allowed-values rule (rows may only use
  the enumerated values; out-of-set or invalid enum cells are structural
  defects) and judged required scope in `contentExpectations` (the verifier
  assesses whether every enumerated value is covered or credibly blocked).
  It never becomes a deterministic presence gate, so a truthful partial
  result is always structurally reachable. "Rows may only name these six
  chapters" must not mean "manufacture a row for every chapter."
- [x] Remove the initializer instruction that maps explicit enumerations to
  an `original_task` `matches_expected_values` presence rule. Do not replace
  it with a conditional "only when the request explicitly requires every
  value" test: that classification is nondeterministic across runs and both
  branches fail badly (a hard five-strike deterministic loop when a source
  is down; weakened scope pressure when it is up).
- [x] Preserve explicit row scope and judgment requirements in
  `contentExpectations` so the verifier assesses, for example, the requested
  cohorts without guessing an exact string rendering.
- [x] Keep durable read compatibility: contracts already checkpointed with
  `original_task` `matches_expected_values` rules keep their recorded
  meaning on resume; only newly initialized contracts use the split.
- [x] Keep non-fabrication as a universal worker/verifier invariant rather
  than a task-specific contract heuristic.
- [x] Land this contract change before, or atomically with, the coordinator
  routing change below. Do not expose existing contradictory contracts to a
  hard deterministic loop.

### 4. Restore authoritative deterministic failures

- [x] In the coordinator, return every failed deterministic finish check
  verbatim to the worker, regardless of whether `finish.unresolved` is empty.
- [x] Do not send failed structural checks to the verifier for reinterpretation.
- [x] Preserve the existing bounded deterministic-failure terminal path.
- [x] Keep settled deterministic facts available to the verifier only after
  structural checks pass.

### 5. Simplify and constrain the verifier decision

- [x] Retain the general `needs_correction` outcome so ordinary evidence-backed
  artifact repairs and truthful report revisions do not regress.
- [x] Replace free-form `nextAction` with typed correction findings:

  ```ts
  type CorrectionFinding =
    | {
        kind: 'research';
        requirement: string;
        problem: string;
      }
    | {
        kind: 'artifact_repair';
        requirement: string;
        problem: string;
        evidencePaths: [string, ...string[]];
      }
    | {
        kind: 'report_repair';
        requirement: string;
        problem: string;
      };

  type VerificationDecision =
    | { status: 'verified'; findings: [] }
    | { status: 'needs_correction'; findings: CorrectionFinding[] }
    | {
        status: 'incomplete';
        findings: Array<{
          requirement: string;
          assessment: string;
          evidencePaths?: string[];
        }>;
      };
  ```

- [x] Make `verified` invalid when unresolved requirements are nonempty.
- [x] For a `research` finding, return a concise deterministic harness
  instruction to continue evidence collection without fabricating or padding
  artifacts. The verifier identifies the unsupported requirement but does not
  prescribe artifact contents.
- [x] Permit `artifact_repair` only when its nonempty `evidencePaths` all name
  surfaced files and the cited evidence supports repairing the requested
  artifact. Do not treat an "unavailable" note as support for a synthetic row.
- [x] Restrict `report_repair` to correcting the worker's summary or unresolved
  report; it must not change artifacts or erase a material blocker.
- [x] Give the verifier one explicit rule for the per-column sparsity facts
  from section 6. A conspicuously sparse explicitly requested column with no
  unresolved entry for it, where surfaced evidence shows richer official
  detail pages existed, is a material overclaim of completeness and grounds
  for a `research` finding — the requested field was never optional extra
  information. The same sparsity behind a credible unresolved entry is input
  to blocker-credibility assessment, not a defect. Sparsity facts never
  become hidden thresholds or new requirements.
- [x] Keep identical no-progress findings bounded by the existing durable
  verification history and whole-run budgets.
- [x] If the verifier repeats an invalid verdict after its protocol repair,
  terminate as `verification_incomplete`; reserve `verifier_unavailable` for
  an actual provider/tool availability failure.

### 6. Strengthen research persistence without a new tool

- [x] Add a concise general fallback ladder to the worker instructions:
  canonical page retry, alternate scheme/host, official navigation or sitemap,
  targeted search, archived official pages, then official secondary channels.
- [x] Make the ladder the credibility standard for blockers, not advice. The
  worker must not submit an unresolved requirement while a materially
  different applicable rung remains untried and budget remains, and an
  unresolved entry is credible only when its `attempts` show the applicable
  rungs were walked. The verifier assesses blocker credibility against the
  ladder.
- [x] Make per-column coverage a pre-finish self-check, not a suggestion:
  before calling finish, the worker measures nonblank coverage for every
  requested table column, and a conspicuously sparse requested column with
  untried official profile/detail pages means the work is not done yet. A
  column being structurally optional means unavailable cells may remain
  blank; it does not make the requested field irrelevant.
- [x] Add per-column nonblank counts to deterministic table facts surfaced to
  the verifier. Do not add hidden-grader thresholds or turn those counts into
  deterministic semantic failures.
- [x] Continue using the bounded `finish.unresolved[].attempts` report for the
  initial fix. Do not add a progress tool or a larger protocol unless tests
  show that free-form attempts cannot support the decision reliably.
- [x] Use attempts to assess blocker credibility and to avoid recommending an
  already-tried approach.
- [x] Converge to incomplete only when surfaced evidence is unchanged AND the
  worker reports no new distinct attempted approach for the unsupported
  requirement. A genuinely new approach that dead-ends without producing new
  surfaced evidence still counts as progress for another correction cycle;
  research that fails is not the same as no research. The verifier judges
  distinctness — a reworded description of an already-tried approach is not
  a new attempt — so prose churn alone cannot keep a run alive.
- [x] Let the whole-run budget be the enforceable bound on persistence,
  consistent with the invariant above. Concretely that is the shared
  `RunBudgetTracker` wall-time ceiling (1 hour; worker turns, tool calls,
  model tokens, and verifier corrections are explicitly unbounded, with
  tool calls lifted 2026-08-18 so research depth is bounded by time and
  reachability, not a call counter) plus the separate deterministic
  finish-check rejection ceiling. Tool calls stay observable in metrics for
  detecting pathological runs. Do not add a new per-requirement cycle cap.

### 7. Preserve durable compatibility

- [x] Keep read compatibility for checkpoints containing the current
  `needs_correction`/`nextAction` history. Normalize legacy findings into a
  non-actionable historical assessment; do not execute an old free-form
  instruction after upgrade.
- [x] Cover resume from initializing, checking, verifying, and terminal
  checkpoints written before this follow-up, including pending structural
  findings and old verification history.
- [x] Preserve accounting, correction counts, evidence fingerprints, terminal
  outcomes, and the immutable contract across the migration.
- [x] Keep compatibility code at the durable read boundary rather than
  spreading legacy union handling through the new verifier session.

### 8. Add a deterministic audit report

- [x] Render `harness/findings.md` from already available typed checkpoint and
  verifier data after each durably recorded verification decision.
- [x] Rebuild the complete file atomically rather than appending, so crash
  recovery cannot duplicate or truncate cycles.
- [x] Use the same private-directory permissions, no-follow discipline, size
  bounds, and safe atomic-write conventions as other harness-owned files.
- [x] Regenerate the projection on resume and terminal reopen when its durable
  source state is newer or the file is absent.
- [x] Treat projection failure as an audit/reporting problem, not as authority
  to change an otherwise valid verification outcome. Test the failure path
  explicitly rather than silently coupling terminalization to the file write.
- [x] Include the current status, worker completion report, unresolved
  requirements, deterministic facts/defects, surfaced artifact paths and
  hashes, verifier findings, and prior verification cycles.
- [x] Do not make the verifier writable and do not add an LLM or worker tool
  call. The coordinator/harness owns the rendering.
- [x] Keep the file outside the manifest and requested outputs. It is an audit
  projection, never the machine-readable source of truth and never a grader
  deliverable.

### 9. Verify and re-evaluate

- [x] Run the focused initializer, contract, finish-check, verifier,
  checkpoint, coordinator, and presentation tests after their respective
  slices.
- [x] Run `npm run typecheck`, `git diff --check`, and the complete hermetic
  suite before declaring the follow-up complete.
- [ ] With explicit user direction, rerun Hacker News, YC W24 outreach, and
  MIT sororities CSV. Compare artifact grade, durable outcome, verifier cycles,
  turns, tool calls, latency, and token accounting with the August 17 batch.
- [ ] Treat a k=1 live batch as a regression detector, not proof of
  non-regression. If the user authorizes the additional live cost, use repeated
  trials to estimate whether research depth and artifact quality improved
  without sacrificing Hacker News or YC correctness/efficiency.

## Non-goals

- No task-specific MIT, sorority, or website branches.
- No new verifier browser access or filesystem-write tool.
- No additional post-verification model call.
- No Markdown parsing for control flow; `harness/findings.md` is derived only.
- No placeholder/sentinel row convention for unavailable research subjects.
- No grader-oracle data, transcript, scratch contents, or unpublished browser
  observations in verifier context.
- No implicit live eval or Browserbase run while implementing local changes.
