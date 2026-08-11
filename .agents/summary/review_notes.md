# Review Notes

Consistency and completeness review of the generated documentation and the codebase it describes. Generated 2026-08-10.

## Consistency check

Cross-checked the six documentation files against each other, the code, `.agents/planning/.../design/detailed-design.md`, and `docs/reports/2026-08-11-baseline.md`. Findings:

1. **`@opentelemetry/sdk-node` is declared but never imported** — anywhere in `src/`, `evals/`, `demos/`, or `tests/`. The tracing layer uses `@opentelemetry/sdk-trace-node` instead. Candidate for removal from `package.json`. Noted in [dependencies.md](dependencies.md).
2. **Design doc lists 11 visible eval tasks; only 3 (+ stub) exist as eval packages.** This is checkpoint-1 scope (the three "easy" tasks were baselined), not an error — but readers of the design doc should know the other eight task packages (`yc_founders`, `x_tweets`, `wikipedia_ref`, `airbnb`, etc.) are not yet built. Documented as project state in [codebase_info.md](codebase_info.md).
3. **`metrics.json` filename constant is duplicated**: `METRICS_FILENAME` lives in `src/loop/agentLoop.ts`, and `src/tools/shared/evidence.ts` re-declares the literal in `RESERVED_RUN_METADATA_PATHS` to avoid creating a `tools → loop` import edge. Intentional, but a rename would have to touch both.
4. **The known-failure docs and the code agree**: `maxTurns` is still 12, the `download` tool still lacks the in-page-fetch/download-event fallback, and thinking is still disabled — the four candidate mechanisms (F1–F4) from the baseline report are **not yet applied**, matching the handoff state ("do not apply without user direction"). Documentation describes current code, not the proposed fixes.
5. **SEC oracle User-Agent is a hardcoded personal identity** (`Name email` format in `evals/datasets/edgar/oracle/edgarClient.ts`) rather than a config value. Load-bearing (SEC 403s decorated UAs) and deliberate, but worth knowing before anyone "cleans it up" or another person runs the evals.
6. Resolved: `demos/10-controller.ts` now includes its run command in the header comment.

No contradictions were found between the generated files; terminology is consistent (run directory, manifest, outline, ref, oracle, grader, trial, task pass).

## Completeness check

Areas where documentation or code coverage is intentionally thin, and where a reader may want more:

1. **EDGAR oracle is date-pinned and will rot**: it looks for the 2026-01-29 8-K in `filings.recent`, which is a sliding window — the oracle will start throwing once the filing ages out. Nothing in the eval docs flags a shelf life. Flagged in [interfaces.md](interfaces.md).
2. **JS-triggered downloads are unimplemented** — `download` requires an href-bearing ref; the tool's own error message points at download-event capture as the future mechanism. Relevant to EDGAR-style tasks (baseline failure mode 2).
3. **GitHub oracle is unauthenticated** (60 req/hr) — repeated eval runs in one hour can rate-limit grading. Not documented anywhere in the repo itself.
4. **Screenshot content grading is manual by design** (Tier C): the automated grader checks only PNG magic bytes. The standing human overlay is described in the design doc but has no checklist/procedure doc.
5. **`docs/research/claude-code-harness.md` is gitignored** — a research document referenced by the project's history that new clones will not have. If it is load-bearing, consider tracking it.
6. **No CONTRIBUTING.md / no CI**: there is no CI config, linter, or formatter in the repo; conventions live in the planning docs (e.g. commit-after-verified-step, scoped `git add`). The generated AGENTS.md carries the ones that affect agents.
7. **Hidden-eval readiness is untestable locally** by definition; the no-overfitting rule is the mitigation and is documented prominently.

## Language support limitations

None. The codebase is 100% TypeScript (plus HTML test fixtures); every source file was analyzable, and no documentation gaps result from unsupported languages.

## Recommendations

- Remove `@opentelemetry/sdk-node` or add the import it was intended for.
- Consider an `.env.example` documenting the four env keys (the real `.env` is gitignored and undiscoverable to new contributors).
- When the remaining eight eval tasks are built, extend the task table in [components.md](components.md) and re-run this summary.
- Re-generate this documentation after the F1–F4 mechanisms land, since defaults documented here (maxTurns 12, download semantics, static system prompt content) are the parts most likely to change.
