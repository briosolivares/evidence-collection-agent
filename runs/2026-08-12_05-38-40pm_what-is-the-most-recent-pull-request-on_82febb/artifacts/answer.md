# Most Recent Pull Request on openclaw/openclaw

**PR #122879: "fix(ci): prevent channel add command test timeout"**

- **URL:** https://github.com/openclaw/openclaw/pull/122879
- **Author:** vincentkoc (organization member)
- **Status:** Open (wants to merge into `main` from branch `fix/channels-add-use-env-test-owner`)
- **Opened:** Aug 13, 2026 (most recent PR at time of check, out of 2,113 total pull requests on the repo)
- **Changes:** +38 / −49 lines across 4 files, 1 commit

## What it does

This PR is a CI/test-only fix. It resolves a qualification (CI) failure where the
`channels add` command test suite could exceed its 120-second timeout while
checking the `--use-env` flag, because the test was synchronously loading real
bundled plugin source code (e.g., for Telegram/Jiti loading).

The fix reworks the test suite to register lightweight synthetic setup
contracts for the generic "missing env variable" and "config write" assertions,
instead of loading the actual heavy plugin bundles. Coverage for
plugin-specific declaration/conditional behavior (Telegram, Buzz, Slack) is
preserved in each plugin's own test suite (Slack's synthetic contract
statically declares only `SLACK_BOT_TOKEN`).

Per the PR description:
- No production code changed — this is purely a test-isolation fix.
- No timeout, retry, cache, or loader behavior changed in the actual application.
- No user-visible behavior changes; only qualification/CI runs are affected,
  since they no longer need to execute the full Telegram/Jiti bundle loading
  for this particular command-test surface.

The author included evidence of local test runs (65 tests passing across 4
shards in ~45s) and Blacksmith Testbox runs (31/31 tests passing three times)
to substantiate the fix before requesting review.

## Evidence
- Full-page screenshot of the PR saved at `artifacts/pr-122879-screenshot.png`.
