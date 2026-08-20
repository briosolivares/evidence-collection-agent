# Most Recent Pull Request on openclaw/openclaw

**PR #123024: "chore(config): speed up IO compatibility tests"**
- URL: https://github.com/openclaw/openclaw/pull/123024
- Author: steipete (Contributor)
- Branch: `perf/test-hotspot-round-30` → `main`
- Status at time of review: Open, 1 commit, +51/−57 lines changed (1 file)
- Opened: Aug 13, 2026 (a few minutes before this check)

## What it does

This is a maintenance/test-performance PR (no production or user-facing behavior
change). It speeds up the focused config IO compatibility test suite
(`src/config/io.compat.test.ts`), which had been paying for unrelated overhead:
global test-home cleanup, Doctor recovery migrations, public config facade
exports, and plugin metadata discovery. It also removed duplication where a
six-row canonical bind process table repeated coverage already provided by the
Gateway startup test suite.

The change:
- Uses the prepared `createConfigIO` factory directly instead of pulling in
  unrelated import graphs, replacing them with narrow, fail-fast test fakes.
- Uses a lightweight temp-directory owner since every filesystem test case
  already injects `env` and `homedir`.
- Keeps the discriminating `custom` bind-load probe, while leaving the full
  `lan`/`loopback`/`tailnet`/`auto`/`custom`/default persistence matrix in the
  Gateway E2E test owner.
- Folds an exact newline-format assertion into the existing warning-fingerprint
  lifecycle test instead of running a duplicate load case.
- Makes plugin metadata fakes fail fast (active plugin entries, snapshot
  materialization, and recovery migration) rather than silently falling back to
  an empty registry, while leaving real plugin metadata/validation/migration
  behavior tests in their respective owner suites.

## Measured impact (reported in the PR description)

Running the same suite fresh-cache, single-worker, on Node 24.15.0:
- Wall time: 20.43s → 13.37s (−34.6%)
- Vitest time: 13.85s → 6.83s (−50.7%)
- Import time: 9.95s → 5.72s (−42.5%)
- Test execution time: 3.49s → 0.718s (−79.4%)
- Peak RSS: 432,924 KiB → 376,464 KiB (−13.0%)
- Changed suite: 9/9 tests passed; broader "owner proof" suites: 139/139 passed
- Lint/format checks (oxfmt, Oxlint) passed with no warnings/errors

Net effect: purely a developer-experience / CI-speed improvement to tests —
"No runtime or user-visible behavior changes," per the PR's own "User Impact"
section.

## Source
Captured live from GitHub on the date of this run (repo shows PR counts of
2,101 open / 71,569 closed pull requests, sorted by most recently created).
Screenshot evidence: `artifacts/openclaw_pr_123024.png`.
