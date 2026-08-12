# Browser Batch Tool

Revise the evidence-collection agent harness with a `browser_batch` tool that lets the model submit multiple browser actions in one tool call. The intended interaction is:

```text
model -> browser_batch(action: click, action: type, ...) -> model
```

This should reduce the model turns currently required for sequences such as click/type/click while preserving the existing tool pipeline, Zod validation, deterministic tool schemas, tracing, and transcript semantics. The existing atomic browser tools should remain available initially so an experiment can measure whether Claude chooses `browser_batch` and whether batching improves outcomes.

The design and implementation plan must include an eval-harness experiment comparing the easy evals in two conditions:

1. Atomic browser tools only.
2. Atomic browser tools plus `browser_batch` available.

The experiment must distinguish tool preference/adoption from task quality, cost, latency, and turn-efficiency effects. Do not run the experiment or re-baseline during this planning phase; implementation and execution follow after design review.
