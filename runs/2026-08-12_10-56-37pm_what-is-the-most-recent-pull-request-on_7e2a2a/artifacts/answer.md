# Most Recent Pull Request — openclaw/openclaw

**PR #123024: "chore(config): speed up IO compatibility tests"**

- **URL:** https://github.com/openclaw/openclaw/pull/123024
- **Author:** steipete
- **Branch:** `perf/test-hotspot-round-30` → `main`
- **Opened:** Aug 13, 2026 (a few minutes before this check)
- **Status:** Open, 1 commit, +51/−57 lines changed (1 file)

## What it does

This is a "chore" (maintenance/tooling) PR, not a feature or bug fix. It optimizes
the performance of the project's internal **config IO compatibility test suite**
(`src/config/io.compat.test.ts`) without changing any runtime or user-facing
behavior.

**Problem it addresses:** the focused config IO compatibility test suite was
slow because it incidentally paid the cost of unrelated work — global test-home
cleanup, Doctor recovery migrations, public config facade exports, and plugin
metadata discovery — plus it duplicated a six-row canonical bind process table
that is already covered more thoroughly by the Gateway startup tests.

**Change made:** the PR uses the prepared `createConfigIO` factory directly,
replaces unrelated import graphs with narrow, fail-fast test fakes, and uses a
lightweight temp-directory owner (since every filesystem test case already
injects `env` and `homedir`). It keeps the discriminating `custom` bind-load
probe while leaving the full six-row `lan`/`loopback`/`tailnet`/`auto`/`custom`
persistence matrix to the Gateway end-to-end test owner. It also folds an
exact newline-format assertion into an existing warning-fingerprint lifecycle
test instead of running a separate, duplicate load test case.

**Impact:** No runtime or user-visible behavior changes — this is purely a
developer-experience/CI speed improvement. The PR's own benchmark evidence
(same machine, fresh cache, single worker, Node 24.15.0) shows:
- Wall time: 20.43s → 13.37s (‑34.6%)
- Vitest time: 13.85s → 6.83s (‑50.7%)
- Import time: 9.95s → 5.72s (‑42.5%)
- Test execution time: 3.49s → 0.718s (‑79.4%)
- Peak RSS: 432,924 KiB → 376,464 KiB (‑13.0%)
- All 9 changed-suite tests still pass, and 139/139 tests pass across the
  related config IO, plugin-metadata, plugin-validation, and Doctor
  migration-owner suites.

In short: it's a test-suite performance refactor that makes the config IO
compatibility tests run roughly twice as fast and use less memory, by
removing incidental dependencies and duplicate coverage, with zero change to
production behavior.

---
*Evidence: full-page screenshot of the PR saved at
`artifacts/pr_123024_screenshot.png`.*
