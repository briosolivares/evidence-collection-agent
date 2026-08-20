# Most Recent Pull Request on openclaw/openclaw

**PR:** [#122879 — "fix(ci): prevent channel add command test timeout"](https://github.com/openclaw/openclaw/pull/122879)
**Author:** vincentkoc (member of the openclaw organization)
**Opened:** August 13, 2026
**Status:** Open (wants to merge branch `fix/channels-add-use-env-test-owner` into `main`)
**Diff size:** +38 / -49 lines across 4 files (test files only, no production code)

## What it does

This PR is a test-only CI fix. It resolves a qualification/CI failure where the
`channels add` command's test suite could exceed its 120-second timeout when
checking the `--use-env` flag, because the tests were synchronously loading the
real bundled plugin source (including the Telegram loader) instead of a
lightweight stand-in.

The fix makes the generic `channels add` command tests register lightweight
synthetic setup contracts for the generic "missing-env" and "config-write"
assertions, instead of importing and loading the actual bundled Telegram/Buzz/
Slack plugin code. Channel-specific behavior (declaration and conditional
credential checks) is left in place in each plugin's own test suite — Telegram,
Buzz, and Slack retain their coverage in their owning suites, with Slack still
statically declaring `SLACK_BOT_TOKEN`.

According to the PR description:
- No production code, timeout, retry, cache, or loader behavior was changed.
- No user-visible behavior changes result; only CI/qualification test
  execution changes (it no longer needs to load the bundled Telegram/Jiti
  plugin code for this particular command-test surface).
- Evidence provided includes local Vitest runs (65 tests passed across four
  shards in ~45s) and repeated clean Testbox runs (31/31 tests passed each of
  three times), plus formatting/lint checks passing.

The automated "ClawSweeper" bot review flagged it as "ready for maintainer
review" with two open items: resolving some failing/incomplete CI checks at
the exact commit head before merge, and general confirmation that exact-head
CI passes. As of observation, the PR was still open and unmerged, with 1
commit, 2 comments, and 172 CI checks associated with it.

## Note on repository state

The repository shows extremely high issue/PR numbers (this PR is #122879, with
2,113 open and 71,435 closed PRs total), and the bot/tooling ecosystem
(ClawSweeper, openclaw-barnacle, "Testbox" sandboxes, elaborate auto-generated
review reports) suggests this is a very high-velocity, heavily automated
project. The answer above reflects exactly what was observed on GitHub at the
time of this check.

Source: https://github.com/openclaw/openclaw/pull/122879 (verified via live
browser inspection; screenshot saved as pr_122879_screenshot.png).
