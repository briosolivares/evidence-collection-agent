# Review Notes

Review snapshot for the active summaries as of 2026-08-20. Historical planning and report documents are intentionally not rewritten when architecture changes; use their dates and links as context, not as current module maps.

## Consistency findings

1. **Production has one path.** `src/agent/runTask.ts` composes the initializer, sequential worker, deterministic finish checks, fresh verifier, static nine-tool registry, and durable lifecycle.
2. **The cached worker prefix is static.** `workerPrompt` and `WORKER_API_TOOL_DEFS` hold no task/run/provider state. Per-run facts enter conversation guidance and durable configuration.
3. **Durability is authoritative.** The checkpointed configuration, contract, budget, worker history, pending effect, and terminal outcome are primary. `manifest.json`, `output-contract.json`, transcript, and metrics are durable product/diagnostic projections with explicit recovery rules.
4. **Browser ownership is explicit.** The local TUI attaches to user-owned Chrome, while login and both eval lanes use managed sessions. Browserbase is selected only by the provider variable; possessing a key alone does not start a remote session.
5. **Evaluation remains isolated.** Dataset metadata selects normal/headed lanes and login preflight. Graders see only run-directory files plus fresh oracle data, and published deliverables are selected by manifest role.

## Current operational cautions

- **Browserbase remains live-unverified.** `docs/browserbase-provider-plan.md` records that the billable smoke command and Google Sheets/X acceptance run have not been executed. Fake-backed coverage cannot answer whether remote download behavior, Context persistence, uploads, or target-site fingerprint/IP acceptance work in production.
- **GitHub grading needs authenticated quota.** A batch can finish its agent runs and then fail during fresh-oracle grading with an anonymous REST 403. Use `GITHUB_TOKEN` and distinguish post-run grader failure from agent failure in logs.
- **SEC behavior is unusually strict.** Its oracle User-Agent format and browser-based retrieval paths are load-bearing; generic HTTP-client cleanup can turn valid access into 403s.
- **`bash` is provenance-controlled, not isolated.** It runs as the application user. Bounds, secret filtering, foreground-only execution, workspace confinement, and reconciliation reduce exposure but do not create an OS security boundary.
- **Terminal recovery is intentionally quiet.** It performs no model work; it revalidates checkpoint/run integrity and repairs projections under lock.
- **Do not re-baseline implicitly.** Eval batches consume live sites, credentials, browser resources, and model tokens. The dated reports remain evidence of their own commits, not a standing instruction to rerun them.

## Documentation boundary

- [index.md](index.md) through [workflows.md](workflows.md) describe current production code.
- [The v3 design](../../docs/browser-agent-v3/sherlock-v3-design-doc.md) and [implementation plan](../../docs/browser-agent-v3/implementation-plan.md) explain current rationale and sequencing.
- [Browserbase provider plan](../../docs/browserbase-provider-plan.md) is the provider-specific source of truth, including unverified live assumptions.
- `.agents/planning/evidence-collection-agent-checkpoint-1/` and `docs/reports/` preserve historical decisions and measured results. Paths and protocols in those dated documents may no longer exist.

Refresh these summaries whenever the public run seam, checkpoint schema/version, static tool list/order, provider ownership rules, or run-directory boundary changes.
