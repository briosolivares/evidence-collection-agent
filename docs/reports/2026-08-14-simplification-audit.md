# Sherlock simplification audit and working charter

**Date:** 2026-08-14

**Branch:** `simplify/sherlock-core`

**Branch point:** `bbe94ac12e2857a23931454adcfe4d777a626285` from `feat/judge-harness`

**Status:** Findings recorded; no production simplification has started

## Executive conclusion

Sherlock is substantially overengineered relative to its intended product
experience. The underlying product remains understandable: accept a task,
drive a browser through model-selected tools, stream intelligible progress,
and publish downloadable artifacts with a concise summary. The repository is
large because it now implements several additional systems around that loop:

1. an audit provenance system;
2. an initializer/worker/verifier workflow engine;
3. a typed output-contract and evidence-linked output database;
4. durable checkpointing and exact tool-call recovery;
5. local and Browserbase browser infrastructure;
6. a terminal UI and an evaluation platform.

Most individual pieces have a defensible rationale. Their combined state
space is too large for a solo developer to understand and change confidently.
The repository has optimized for exhaustive local policy enforcement and
agent-parallel implementation at the expense of global coherence.

The correct response is not indiscriminate test deletion, comment removal, or
moving files to make a line counter smaller. It is to choose a smaller product
contract, remove whole mechanisms that do not support it, and delete the tests
that exist only for those mechanisms.

## Scope of this audit

This assessment covers the checked-out `feat/judge-harness` state at
`bbe94ac`, immediately before this branch was created. It is a diagnostic and
planning document, not an authorization to remove product behavior.

The existing untracked file `docs/architecture-whiteboard.html` is user-owned
and was deliberately left untouched and uncommitted.

## Measurement convention

The baseline uses three deliberately separate measurements:

- **Raw lines:** physical lines reported by `wc -l`.
- **Production src:** files under `src/` excluding `*.test.ts` and
  `*.test.tsx`.
- **Tests:** every tracked `*.test.ts` and `*.test.tsx`, plus the exact test
  cases collected by Vitest.

The approximate code/comment split classifies blank lines and lines beginning
with `//`, `/*`, `*`, or `*/`. It is useful for orientation but is not a
language-aware SLOC counter. It must not become the before/after success
metric. Doc comments are maintained text and remain part of the raw production
size.

Reproduction commands used during the audit included:

    git ls-files | wc -l
    rg --files src
    wc -l <file sets>
    npx vitest list --json
    npm run typecheck
    npx tsc --noEmit --traceResolution

No formatter or exclusion rule was changed to improve the numbers.

## Current baseline

| Measure | Current value |
| --- | ---: |
| Tracked files | 502 |
| Files under `src/` | 208 |
| Raw lines under `src/` | 58,531 |
| Production `src` | 33,531 lines in 132 files |
| Co-located `src` tests | 25,000 lines in 76 files |
| All test code | 36,433 lines in 140 files |
| Vitest cases collected | 1,830 |
| `src/browser` | 10,404 lines in 25 files |
| `evals` | 12,870 lines in 120 files |
| `.agents` plus `docs` | 20,736 lines in 97 files |
| Commits from 2026-08-09 through 2026-08-14 | 325 |

Production `src` contains approximately 20,301 nonblank, non-comment-only
lines, 11,043 comment-only lines, and 2,187 blank lines. Raw LOC therefore
overstates executable logic, but the comments, files, types, and policies
still contribute to the human maintenance surface.

The test suite is larger than shipping source by raw lines: 36,433 test lines
versus 33,531 production `src` lines. That ratio is not automatically wrong,
but here it reflects an unusually large policy state space.

### Production source by area

| Area | Raw production lines | Production files |
| --- | ---: | ---: |
| Browser | 7,015 | 17 |
| TUI | 5,417 | 33 |
| Tools | 4,992 | 26 |
| CLI/composition | 3,898 | 17 |
| Loop and model | 3,198 | 9 |
| Contracts, harness, completion, outputs, evidence | 5,725 | 18 |
| Run/provenance/checkpointing | 1,981 | 8 |
| Content readers | 837 | 4 |
| Tracing and config | 468 | 2 |

The agent kernel is not the dominant cost. The loop and model client together
are about 3,200 raw lines; policy, product surfaces, and infrastructure account
for the rest.

### Growth history

The growth was extremely compressed in time:

| Revision | Milestone | Production `src` | Co-located `src` tests |
| --- | --- | ---: | ---: |
| `a4ab9f1` | Checkpoint 1 complete | 3,101 / 23 files | 3,437 / 20 files |
| `5694178` | Initial TUI complete | 5,895 / 44 files | 3,437 / 20 files |
| `0911e03` | Judge/V2/local-execution peak | 36,260 / 130 files | 27,181 / 86 files |
| `b1fd6ea` | V2-only cutover | 30,679 / 112 files | 22,477 / 67 files |
| `bbe94ac` | Current branch point | 33,531 / 132 files | 25,000 / 76 files |

Production `src` grew more than tenfold from checkpoint 1. Across the entire
repository, 2026-08-13 alone recorded 59,391 inserted and 5,599 deleted lines,
a net increase of 53,792 lines. That pace did not leave time for a human-scale
architectural consolidation pass.

## Findings

### 1. Critical: the product boundary expanded without a complexity budget

The original architecture was a small model/tool loop. It now unconditionally
runs a typed-contract initializer, persistent worker, deterministic completion
checks, and a verifier. It also supports long-running shell commands, browser
scripts, exact checkpoint recovery, two browser providers, authenticated eval
lanes, document readers, evidence-linked tables, and a full TUI.

This is not one browser agent implementation becoming verbose. It is multiple
products sharing one process and repository.

**Maintenance cost:** a change to task execution can cross CLI composition,
worker state, scheduler access declarations, contract state, evidence state,
output rendering, checkpoint serialization, tracing, and TUI events.

**Direction:** state one small product promise and treat every capability
outside it as an explicit keep/cut/defer decision.

### 2. Critical: local policy has become a distributed-systems protocol

The code includes concepts normally justified by multiple workers or durable
services: append-only revisions, lock ownership, stale-lock recovery, atomic
replacement, fsync, pending-call replay, busy-resource ledgers, abandonment
tracking, conflict-aware scheduling, multi-role budgets, and verification
cycles.

These mechanisms are internally coherent. The problem is that a single-user
browser assistant now pays their cognitive cost on every run.

**Concrete evidence:**

- `runTask.ts` imports 27 internal modules.
- `runToolchain.ts` imports 23.
- `harnessCycles.ts` and `workerSession.ts` each import 15.
- `runCheckpointStore.ts` is 733 lines before its callers and tests.
- `workerSession.ts` is 981 lines.
- `completionCheck.ts` is 1,006 lines.
- `outputContract.ts` is 860 lines.

**Direction:** prefer serial execution, one in-memory run state, one completion
path, and at most a turn-boundary checkpoint. Reintroduce stronger machinery
only after a measured product failure requires it.

### 3. High: optimized for implementation agents, not a solo human

Planning explicitly organized work for delegation to multiple coding agents,
with narrow verification checklists and one commit per mechanism. That is good
for throughput and local reviewability. It encourages every task to arrive as
a complete abstraction with tests and documentation before the whole system is
reconsidered.

**Maintenance cost:** the result is locally defensible but globally difficult
to hold in working memory. File boundaries mirror implementation tasks more
often than the product's few enduring concepts.

**Direction:** future architecture reviews must optimize for the question,
"Can one developer explain the complete run path on one page?"

### 4. High: tests mirror the state space and preserve non-product modes

Current test-case concentrations include:

| Area | Collected cases |
| --- | ---: |
| `tests/` (mostly TUI) | 335 |
| Tools | 313 |
| Evals | 264 |
| Browser | 175 |
| Run | 124 |
| CLI | 122 |
| Outputs | 105 |
| Loop | 100 |

Examples of feature-driven matrices include 38 checkpoint-store cases, 74
output-contract/completion-check cases, and roughly 160 Browserbase cases.
Those tests are not the root problem: their production features create real
edge cases once retained.

There is nevertheless avoidable test surface. Production requires a contract
and verifier, while worker types and tests still support absent contract stores,
legacy completion results, and worker-only demo paths. TUI tests also preserve
terminology and event shapes from deleted tools.

**Direction:** delete product modes first and their tests in the same commit.
For retained behavior, prefer public-boundary and representative partition
tests over tests that freeze private call sequences and every no-op reducer
transition.

### 5. High: `src/browser` is both flat and internally over-segmented

The browser directory contains 25 visible files: 17 production files and 8
tests. Its 10,404 raw lines divide into 7,015 production and 3,389 test lines.
Production browser source contains approximately 3,805 nonblank,
non-comment-only lines, 2,787 comment-only lines, and 423 blank lines.

The visible flood comes from four concerns sharing one flat directory:

- browser-domain state and action receipts;
- local Playwright control;
- Browserbase session/download/retry behavior;
- browser-attached JavaScript and command reconciliation.

Moving tests or adding folders would improve Explorer navigation but would not
make the system smaller. The real reduction comes from deciding whether the
shell/script lifecycle and both providers belong in the core product.

**Direction if both providers remain:** expose one small browser facade and
organize private code under `browser/core`, `browser/local`, and
`browser/remote`. Keep scripting separate and optional. Do not claim file moves
as SLOC improvement.

### 6. High: documentation no longer provides a trustworthy map

The generated `.agents/summary` describes the checkpoint-1 architecture from
2026-08-10: ten tools, no Bash, old completion behavior, and old defaults.
README, AGENTS.md, handoff notes, reports, and source disagree on several of
those facts.

There are over 20,000 lines under `.agents` and `docs`. Historical reports are
valuable evidence, but they are presented alongside active architecture
instructions without one concise current source of truth.

**Direction:** retain history as history, remove or regenerate the stale
summary, and replace the active navigation surface with one short product
architecture document and one current decision log.

### 7. Medium: security complexity is mostly real after the capabilities are
chosen

Path confinement, manifest hashing, secret denial, remote upload encoding,
download verification, cancellation, and process cleanup are not arbitrary
once the product has arbitrary shell access, untrusted page content, remote CDP
credentials, and audit-grade provenance.

The simplifying move is not to retain those capabilities while deleting their
guards. It is to question the capability itself. Removing Bash, browser-attached
shell scripts, parallel tool execution, or exact mid-call recovery safely
removes the associated security protocol and its tests.

## Patterns worth preserving

The audit does not conclude that every abstraction is waste. These ideas are
strong and should survive in a smaller form:

- one composition root;
- one model/tool loop with streamed progress;
- a small browser facade independent of Playwright details;
- a provider seam if local and remote browsers are both real product needs;
- one artifact-writing boundary with manifest hashes;
- a clear published-artifact versus private-scratch distinction;
- basic model-supplied path confinement;
- bounded model-visible tool output;
- deterministic tool definitions and prompt-prefix behavior;
- a human-question handoff and visible cancellation;
- black-box evals that grade final artifacts rather than model claims.

These are product boundaries. They do not require the current number of stores,
protocols, roles, or files.

## Proposed product promise

The simplification target should be understandable in one sentence:

> Sherlock accepts a research task, drives a browser through a small set of
> visible actions, streams a human-readable plan and progress, and returns
> downloadable artifacts plus a concise summary with lightweight provenance.

Anything not required by that sentence is optional until explicitly retained.

## Proposed target architecture

The desired runtime has five concepts:

1. **Application:** chat/TUI, progress presentation, human questions, artifact
   downloads.
2. **Agent:** one conversation, one model driver, one sequential tool loop.
3. **Browser:** one small facade with local and optional remote adapters.
4. **Tools:** a compact set that translates model requests into browser or
   artifact operations.
5. **Run store:** transcript, published files, lightweight manifest, and
   optional turn-boundary state.

One possible directory shape is:

    src/
      app/
      agent/
      browser/
        local/
        remote/
      tools/
      runs/

This is illustrative, not a request to move files before mechanisms are
removed. Deep, cohesive modules are preferred over both one-file-per-policy
fragmentation and new god objects.

### Candidate tool surface

The target user experience can likely be supported by roughly eight or nine
tools:

- observe/read page;
- browser action, including navigation;
- execute page JavaScript;
- screenshot;
- download/upload;
- create or update an artifact;
- read/search a run file;
- ask the user;
- present/finish.

The exact names and schemas are a later design decision because changing them
changes the prompt prefix and agent behavior. The key simplification is one
tool per user-visible capability family, not one tool per internal store.

## Preliminary keep/cut/defer matrix

No row below authorizes a behavior change. It records the recommended starting
position for an explicit product decision.

| Mechanism | Recommendation | Reason |
| --- | --- | --- |
| Single model/tool loop | Keep | Core product |
| TUI progress and artifact UX | Keep, simplify | Matches intended experience |
| Run directory and artifact manifest | Keep, simplify | Core evidence value |
| Browser facade | Keep | Useful product boundary |
| Local Chrome | Keep | Reliable development and interactive path |
| Browserbase | Decide | Real operational value, but substantial cost |
| Sequential tool execution | Prefer | Removes scheduler/access/busy protocol |
| Initializer role | Cut or ablate | Separate model stage has unclear product value |
| Verifier role | Ablate before cut | Quality benefit exists, latency cost is material |
| Typed contract revisions | Cut or collapse | Large policy surface around simple outputs |
| Evidence-linked row store | Cut or collapse | Artifact generation should not require a database |
| Deterministic completion checks | Keep only simple boundary checks | Exact files/schema may remain useful |
| Bash | Cut unless declared core | Pulls in the largest security/lifecycle burden |
| Browser-attached shell scripts | Cut | Duplicates direct browser JavaScript capability |
| Exact mid-tool checkpoint recovery | Cut | Excessive for a local assistant |
| Turn-boundary checkpoint | Defer/keep small | Useful for expensive long runs |
| PDF/spreadsheet/OCR readers | Defer individually | Keep only demonstrated product needs |
| Langfuse tracing | Optional adapter | Should not shape core execution |
| Eval harness | Keep outside shipping core | Needed for quality, not product runtime |
| TUI eval menu | Cut or defer | Couples product UI to development infrastructure |
| Numbered demos | Cut after acceptance tests replace them | They preserve alternate runtime modes |

## Credible size target

This is a directional engineering range, not a quota:

- **Local-only product:** approximately 8,000–12,000 raw production lines.
- **Local plus Browserbase:** approximately 12,000–18,000 raw production
  lines.
- **Production file count:** roughly 40–70, depending on UI component
  granularity.
- **Tests:** likely 300–600 collected cases, driven by retained behavior rather
  than a fixed count.

The target must not be reached by packing lines, deleting useful explanations,
editing the measurement, or moving unchanged code outside counted paths.
Structural subsystem removal should account for the overwhelming majority of
any reduction.

Equivalent agent effectiveness is plausible but not established. Existing
reports show that the judge harness improved quality on some tasks while the
new architecture was about 2.4 times slower on directly comparable work. The
typed-contract latency check was mixed and too small to establish a win. Major
protocol removal therefore needs a controlled comparison against representative
acceptance tasks.

## Required feedback loops before the first code deletion

| Preflight item | Status |
| --- | --- |
| Dedicated branch | Complete |
| Reproducible raw source/test baseline | Complete |
| Exact current test inventory | Complete: 1,830 collected |
| Typecheck baseline | Complete: clean during audit |
| Full current test run | Pending |
| Representative real application smoke run | Pending |
| Five acceptance journeys and expected outputs | Pending |
| Semantic dependency graph | Partial: TypeScript resolution fan-in/out mapped |
| Semantic dead-code/unused-export report | Pending |
| Product keep/cut/defer decisions | Pending user approval |
| Milestone log with structural-versus-cosmetic split | This document will hold it |

The regular suite requires local Chrome. Real model runs spend tokens, and the
repository explicitly forbids an eval re-baseline without user direction. No
live eval batch should be inferred from this simplification charter.

## Proposed acceptance journeys

Before removing architecture, pin a small black-box product baseline:

1. **Public research to table:** browse a public site and publish an exact
   small CSV plus summary.
2. **Evidence capture:** locate a source, publish a screenshot or download,
   and preserve source provenance.
3. **Multi-page synthesis:** retrieve two or more documents and publish one
   human-readable answer with linked artifacts.
4. **Human handoff:** encounter a login/permission decision, ask the user, and
   continue or stop truthfully.
5. **Cancellation/recovery:** cancel a live task without orphaning browser or
   command resources; decide separately whether resumption is a product
   requirement.

If Browserbase is retained, repeat the relevant browser journey remotely. A
large per-task eval matrix is not needed for every local refactor milestone.

## Structural reduction order

Each item should be a separately verified and reversible milestone. Do not
start several overlapping architectural cuts in parallel.

### Milestone 0: pin the product baseline

- Agree on the product promise and keep/cut/defer matrix.
- Run typecheck and the full hermetic suite.
- Run the representative application smoke path.
- Record wall time, cost where applicable, source lines, file count, and test
  count.
- Run a semantic dead-code and unused-export tool before claiming anything is
  dead.

### Milestone 1: remove impossible and non-product modes

- Remove legacy contract-less, judge-less, and worker-only compatibility paths
  that production cannot enter.
- Remove or update demos that are their only callers.
- Delete tests that exist solely for those removed modes.
- Consolidate current documentation into one trustworthy active map.

This is the lowest-risk structural work because it aligns implementation with
the already-declared production contract.

### Milestone 2: make tool execution sequential

- Execute model-requested tool calls in request order.
- Remove input-aware access declarations, conflict detection, busy-resource
  coordination, and abandonment state that exist only for parallel scheduling.
- Preserve ordered tool results, cancellation, and bounded outputs.
- Measure any latency regression rather than assuming concurrency matters.

This is expected to remove a disproportionate amount of protocol relative to
its user-visible effect.

### Milestone 3: decide the shell boundary

If Bash is not core product behavior:

- remove Bash and foreground process execution;
- remove scratch-workspace reconciliation;
- remove browser-attached shell lifecycle and CDP relay concerns;
- retain direct bounded page JavaScript if needed;
- delete the security, cancellation, and provenance tests that only Bash
  requires.

If Bash remains, its safety code remains load-bearing and should not be trimmed
merely to improve SLOC.

### Milestone 4: collapse the completion harness

- Compare the current initializer/worker/verifier path with one persistent
  agent session and an explicit present/finish tool.
- Retain only deterministic checks that protect user-requested output shape,
  file existence, and provenance.
- Remove contract revision history, typed-row mutation protocol, evidence
  database, multi-cycle verifier orchestration, and their compatibility seams
  if the simpler path holds acceptance quality.

This is the largest likely structural win and the highest behavioral risk. It
requires measured approval, not a blind rewrite.

### Milestone 5: reduce persistence to the product requirement

- Decide whether users need to resume killed runs or merely retain finished
  artifacts.
- Prefer an atomic turn-boundary snapshot if resumption is retained.
- Remove process locks, pending-call exact replay, fsync protocol, revision
  arbitration, and stale-lock recovery unless a demonstrated concurrent-resume
  use case requires them.

### Milestone 6: simplify browser organization and provider scope

- Decide whether Browserbase is a shipped capability or an experiment.
- Keep one narrow browser facade.
- Separate local and remote adapters behind it.
- Collapse incidental helper types and move tests out of the production
  directory where that improves navigation.
- Do not count file moves as structural reduction.

### Milestone 7: separate product, eval, and history surfaces

- Keep the black-box eval harness, but move it behind a clear development-only
  boundary or separate package.
- Replace per-task boilerplate with data-driven definitions where semantics
  really match.
- Remove obsolete generated summaries and label historical reports clearly.
- Keep one short current architecture document.

## Milestone reporting rule

Every completed simplification milestone must report:

- behavior intentionally removed, if any;
- production and test line deltas under the same measurement;
- files and collected tests removed;
- static checks, focused tests, full tests, and real smoke runs actually run;
- accuracy, latency, and cost observations where applicable;
- percentage of reduction from structural work versus comment/formatting
  hygiene;
- remaining risks and the next stop condition.

If cosmetic changes dominate a milestone, stop and do not represent it as
architectural progress.

## Immediate next decision

Before changing code, the owner should confirm or revise the preliminary
keep/cut/defer matrix, especially these four scope choices:

1. Must Browserbase ship in the simplified product?
2. Must arbitrary Bash remain available to the model?
3. Must a killed run resume, or is preserving completed artifacts sufficient?
4. Must every run use an initializer and verifier, or may one agent finish
   directly after deterministic output checks?

Those decisions determine the honest floor. Without them, a numerical SLOC
target would be arbitrary and likely to encourage cosmetic work.
