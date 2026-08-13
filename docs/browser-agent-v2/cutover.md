# Browser Agent V2 — cutover state and the two prepared experiments

**Status:** V2 is implemented and gated by hermetic tests. It is **not yet the
production default.** This document records exactly what is live, what is
dormant, what must be measured before the remaining switches are thrown, and
how to run those measurements.

**Date:** 2026-08-13

---

## What is live in production today

Nothing about the default run path changed. Concretely:

| Setting | Current value | Meaning |
| --- | --- | --- |
| `harness.outputContract` | `false` | The prose `INTENT.md`/`CONTRACT.md` path runs. The typed contract, contract-first gate, code checks, and submission protocol are all built and tested but not engaged. |
| `harness.contractAuthor` | `'initializer'` | Only read when `outputContract` is true. |
| Compact memory | unwired | `AgentContext` and `compactAtBoundary` exist and are tested; nothing calls them. Runs use the historical monotonic conversation plus `inspect_page` elision. |
| `browser_batch` | registered | Retained for the parity comparison. `browser_action` is its receipted replacement. |
| V2 tool registry | not default | `createProductionRegistry()` still builds the atomic surface. `createV2Registry()` exists with a frozen order and a snapshot test. |
| Verifier | live in harness mode | `report_verification` replaced the prose judge outright — this one was not gated behind a flag, because a prose verdict that cannot be trusted is not a configuration worth keeping. |

So a run today behaves as it did before, with two exceptions that are strict
improvements and were not made optional:

1. **The model driver is strict** (T1). A truncated, refused, or over-cap
   response can no longer complete a run or execute tools.
2. **Outcomes are truthful** (T2/T3). Judge crash, correction exhaustion, and
   budget exhaustion end as `incomplete` with preserved artifacts instead of
   reporting success.

## Why the remaining switches are not thrown

Each one is a bet that wants evidence, and the evidence costs live runs:

- Turning on `outputContract` changes how the worker is asked to work at all.
- Choosing a `contractAuthor` picks between two failure modes, not between
  better and worse.
- Enabling compaction risks discarding something the worker needed, which is
  only visible as a pass-rate change.
- Deleting `browser_batch` is irreversible in practice once the prompt and
  eval baselines move.

The user deferred both experiments on 2026-08-13 in favour of testing the
stack end to end first. That decision is recorded in `progress.md`.

---

## Experiment 1 — the four-way contract-author × verifier matrix

**Question:** who should state the output contract, and how much of the
quality comes from verification rather than from having a typed contract at
all?

**Cells:**

| Cell | `contractAuthor` | Verifier | What it isolates |
| --- | --- | --- | --- |
| A | `worker` | off | Typed contract alone, authored with full task context. |
| B | `worker` | on | Whether verification catches a worker grading its own homework. |
| C | `initializer` | off | Typed contract alone, authored before any page can bias it. |
| D | `initializer` | on | The full V2 path. |

**The tension being measured.** Worker-authored contracts come from the same
context that will do the work, so they are more coherent — but the worker can
quietly write itself an easy contract and then satisfy it. Initializer-authored
contracts are committed before any browsing can bias them, so they are harder
to game — but the initializer has never seen a page and can mis-state what the
task actually needs.

**Metrics**, per the plan: pass rate, first-review acceptance rate, correction
count, wall time, total model cost, cache read/write tokens, browser turns, and
the distribution of incomplete causes.

**How to run it.** All four cells are reachable through configuration alone; no
code change is required:

```ts
// Cell D, the full V2 path:
harness: { outputContract: true, contractAuthor: 'initializer' }
// Cell B:
harness: { outputContract: true, contractAuthor: 'worker' }
// Cells A and C: same as B and D, with the verifier disabled.
```

Run each cell over the same task set at the same `k`, on the same day, with the
same model ids. Record the run directories; `harness.json` and `metrics.json`
already carry everything the comparison needs — per-role token usage, per-cycle
verdicts, and the truthful outcome.

**Decision rule.** Pick the author with the better pass rate. If pass rates tie
within noise, prefer the cheaper cell — and say so explicitly rather than
letting a tie default to whatever is currently configured.

## Experiment 2 — compact versus non-compact memory

**Question:** does compacting older observations at a cache boundary preserve
pass rate while improving wall time or cost?

**Why a test cannot answer it.** Hermetic tests already prove the mechanical
properties: unchanged state produces byte-identical history, an offloaded
preview replays identically, a repeated failure stays visible after its raw
events age out, and the current contract/output/evidence facts are never
compacted away. What they cannot prove is that nothing the worker *needed* went
missing. That shows up only as a pass-rate difference on real tasks.

**Metrics:** pass rate first, then uncached input tokens, cache read/write
tokens, time to first token, total cost, context peak, and repeated-action rate.

**Decision rule**, from the plan: compact memory graduates **only** if pass rate
holds and wall time or cost improves. A tie on cost with a pass-rate drop is a
rejection, not a wash.

---

## Legacy removal — what each deletion is waiting on

| To remove | Gate | Status |
| --- | --- | --- |
| `browser_batch` | `browser_action` parity plus a user-authorized measured comparison | `browser_action` is implemented with receipts and reaches feature parity; the measurement has not been run. **Do not delete yet.** |
| Prose `INTENT.md`/`CONTRACT.md` and `runInitializer` | `outputContract` becomes the default | Blocked on experiment 1. |
| Raw model-authored requested-output CSV (`write_file` into a contract-bound path) | T7 table rendering becomes the only path | Renderers are live; `write_file` is still permitted, and the check that a document output must come from `write_document` is the one T8 item left unimplemented (it needs a `src/completion/` edit — see that INTEGRATION note). |
| `runAgentLoop` compatibility wrapper | no caller remains | Still used by the judge-less path and many tests. |
| `readOnly` on `ToolDef` | every production tool declares `getAccess` | The ten atomic tools now declare it; the V2 factories need the same before the field can go. |

## Known gaps, stated plainly

These are real and not hidden behind a flag:

- **`drag`** is not implemented in `browser_action` (T10). It needs a two-target
  revalidation contract and a non-flaky fixture.
- **`table` and `visual` observation needs**, and targeted-region observation,
  are not implemented (T11). `observe` supports `interactive` and `text`.
- **`validateDocumentOutputs()`** is not implemented (T8), so a document output
  hand-written with `write_file` is not yet rejected.
- **Compaction is unwired** (T15), by decision rather than omission.
- The **DNS-rebinding TOCTOU window** in `read_resource` is narrowed by per-hop
  re-resolution but not closed; a pinning HTTP client can be injected without
  touching the security gate.
