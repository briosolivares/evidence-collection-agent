# Knowledge Base Index — evidence-collection-agent

This directory is the current architecture summary for Sherlock's production path as of 2026-08-20.

## How to use this documentation

1. Start here, then open the one or two pages that match the question.
2. Treat referenced source as authoritative when behavior has changed since these summaries were refreshed.
3. Use [the v3 design](../../docs/browser-agent-v3/sherlock-v3-design-doc.md) and [implementation plan](../../docs/browser-agent-v3/implementation-plan.md) for rationale and migration history. Older checkpoint-1 planning remains useful history, but it does not describe the active runtime.
4. Preserve the binding invariants in [architecture.md](architecture.md): immutable contract, explicit `finish`, sequential effects, durable checkpointing, manifest provenance, and grader isolation.

## Contents

| File | Contents | Read it for… |
| --- | --- | --- |
| [codebase_info.md](codebase_info.md) | Purpose, stack, repository layout, entry points, scripts | Orientation and “where is X?” |
| [architecture.md](architecture.md) | v3 lifecycle, layers, invariants, browser policy, defaults | Design and runtime behavior |
| [components.md](components.md) | Responsibilities of active source/eval/test areas | Module ownership |
| [interfaces.md](interfaces.md) | Browser, model, tool, run, checkpoint, tracing, and eval seams | Integration work |
| [data_models.md](data_models.md) | Run directory, manifest, contract, checkpoint, budget, transcript, eval report | Persisted and in-memory shapes |
| [workflows.md](workflows.md) | Fresh run, worker turn, verification, recovery, browser lanes, grading | End-to-end execution |
| [dependencies.md](dependencies.md) | Runtime/development dependencies and environment assumptions | Setup and dependency changes |
| [review_notes.md](review_notes.md) | Current caveats and documentation boundaries | Cleanup and risk review |

## Current production path

```text
runTask
  → immutable contract initializer
  → sequential worker (9 static tools)
  → exclusive finish request
  → deterministic read-only checks
  → fresh read-only verifier
  → verified or explicit incomplete outcome
```

`runAgent` checkpoints every durable boundary under `harness/`. A response with no tools means “continue”, not completion. Historical dispatch, mutable-store, and completion-protocol surfaces are not part of the active architecture.

## Typical reading paths

- Change run behavior: [architecture.md](architecture.md) → [components.md](components.md) → [interfaces.md](interfaces.md).
- Debug crash recovery: [workflows.md](workflows.md) → [data_models.md](data_models.md).
- Add or change a tool: [components.md](components.md) → [interfaces.md](interfaces.md) → `src/tools/`.
- Work on browsers: [architecture.md](architecture.md) → [interfaces.md](interfaces.md) → [Browserbase plan](../../docs/browserbase-provider-plan.md).
- Work on evals: [components.md](components.md) → [interfaces.md](interfaces.md) → [workflows.md](workflows.md).

## Related documents

- `AGENTS.md` — binding repository rules and operational gotchas.
- `README.md` — human-facing setup and use.
- [`docs/browser-agent-v3/sherlock-v3-design-doc.md`](../../docs/browser-agent-v3/sherlock-v3-design-doc.md) — v3 rationale.
- [`docs/browser-agent-v3/implementation-plan.md`](../../docs/browser-agent-v3/implementation-plan.md) — v3 migration/checklist history.
- [`docs/browserbase-provider-plan.md`](../../docs/browserbase-provider-plan.md) — local/remote provider design and live-smoke status.
- [`checkpoint-1 detailed design`](../planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md) — historical design context only.
- [`docs/reports/`](../../docs/reports/) — dated baseline and evaluation reports.
