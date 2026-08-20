# Most Recent Pull Request on openclaw/openclaw

**PR #123024: "chore(config): speed up IO compatibility tests"**

- **URL:** https://github.com/openclaw/openclaw/pull/123024
- **Author:** steipete
- **Status:** Open (wants to merge 1 commit into `main` from branch `perf/test-hotspot-round-30`)
- **Opened:** Aug 13, 2026
- **Changes:** +51 / −57 lines, 1 file changed (tests only — no production code touched)

## What it does

This PR is a test-performance/cleanup change, not a feature or bug fix. It speeds up the
focused config IO compatibility test suite (`src/config/io.compat.test.ts`), which had been
paying for unrelated overhead: unnecessary global test-home cleanup, Doctor recovery
migrations, public config facade exports, and plugin metadata discovery. It also removed
duplication with the stronger Gateway startup test coverage (a six-row canonical bind
process table).

Specifically, the change:
- Uses the prepared `createConfigIO` factory directly instead of importing broader,
  unrelated import graphs.
- Replaces those imports with narrow, fail-fast test fakes.
- Uses a lightweight temp-directory owner since every filesystem test case already injects
  `env` and `homedir`.
- Keeps the discriminating `custom` bind load probe while leaving the Gateway end-to-end
  test as the sole owner of the full `lan`/`loopback`/`tailnet`/`auto`/`custom`/default
  persistence matrix.
- Folds an exact newline-format assertion into the existing warning-fingerprint lifecycle
  test rather than running it as a separate, duplicate load case.
- Makes plugin metadata fakes fail fast (rather than silently defaulting to an empty
  registry) for active plugin entries, snapshot materialization, and recovery migration.

**User impact:** None — there are no runtime or user-visible behavior changes. It only
makes local/CI developer feedback faster for that specific test file.

**Reported evidence/results (from the PR description):**
- Wall time: 20.43s → 13.37s (−34.6%)
- Vitest time: 13.85s → 6.83s (−50.7%)
- Import time: 9.95s → 5.72s (−42.5%)
- Test execution time: 3.49s → 0.718s (−79.4%)
- Peak RSS: 432,924 KiB → 376,464 KiB (−13.0%)
- Changed suite: 9/9 tests passed; broader owner-suite regression check: 139/139 passed
- Lint/format checks (`oxfmt`, Oxlint, `git diff --check`) all passed

**Labels:** `maintainer`, `size: S`
**Reviewers:** none yet requested; no reviews at time of capture
**Participants:** steipete (author), ampagent (bot/commit author for a follow-up commit
"test(config): trim IO compatibility suite imports")

A bot ("clawsweeper") had just picked up the PR for review processing when this was
captured, and the openclaw-barnacle bot auto-applied the `size: S` and `maintainer` labels.

---
*Evidence: see `pr-123024-screenshot.png` for a full-page screenshot of the PR's
conversation tab, captured directly from https://github.com/openclaw/openclaw/pull/123024.*
