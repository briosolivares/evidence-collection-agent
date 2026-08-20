# OpenClaw — Last 10 Merged Pull Requests: Evidence

Source: https://github.com/openclaw/openclaw/pulls?q=is%3Apr+is%3Amerged (sorted "Newest", i.e. most recently created merged PRs — GitHub's PR search has no direct "most recently merged" sort; "Newest"/created-desc is the closest built-in option and, combined with `is:merged`, surfaces the pull requests that most recently completed the merge queue).

Snapshot taken: Aug 13, 2026 (per GitHub UI relative timestamps at capture time).

## Deliverables
- `pull_requests.csv` — pr_number, committer, reviewer, merger for the 10 PRs below.
- `pr_<number>.png` — full-page screenshot of each PR's GitHub page (Conversation tab).

## PR list (most recent 10 merged, newest first)
1. #123013 — feat(worker): expose supervised terminal outcomes
2. #123012 — improve: speed up attempt execution helper tests
3. #123011 — fix(ui): stop limited Custodian access prompting Gateway updates
4. #123007 — fix(parallels): recover migration-refused gateway startup
5. #123006 — refactor(agents): move recovery transcript proof to QA
6. #123003 — refactor(ui): one task-detail surface for rail and subagent clicks
7. #123001 — fix(signal): fail probe when RPC verification fails
8. #123000 — fix(e2e): declare agents-delete fixture owners
9. #122998 — improve: speed up MCP runtime tests
10. #122997 — fix(agents): report headless wall-clock expiry consistently

## Column definitions
- **pr_number**: GitHub pull request number.
- **committer**: GitHub user credited as the author/committer of the commit(s) in the PR (per the PR's "Commits" tab).
- **reviewer**: GitHub user(s) listed under the PR's "Reviewers" sidebar section who submitted a formal review. All 10 PRs in this set show "No reviews" in that sidebar, recorded here as `None`.
- **merger**: GitHub user who performed the merge action ("X merged commit ... into main").

## Notes
- For PRs #123012 and #122998, the commit author shown on the Commits tab is `ampagent` (an automation/agent account) even though the PR was opened and merged by `steipete`; the CSV reports the actual commit author as `committer`.
- No PR in this set had a completed formal GitHub review (approval/changes-requested); each PR page's "Reviewers" panel stated "No reviews", so `reviewer` is `None` for all 10 rows.
