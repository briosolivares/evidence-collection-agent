# Roster: Last 10 merged PRs on openclaw/openclaw (by merged_at desc)

Source: GitHub REST API /repos/openclaw/openclaw/pulls?state=closed&sort=updated&direction=desc
Verified merged_at timestamps decreasing monotonically in this order.

1. PR #123005 - merged_at 2026-08-13T06:47:29Z
2. PR #123027 - merged_at 2026-08-13T06:45:59Z
3. PR #122871 - merged_at 2026-08-13T06:39:18Z
4. PR #123034 - merged_at 2026-08-13T06:37:22Z
5. PR #122878 - merged_at 2026-08-13T06:34:06Z
6. PR #123019 - merged_at 2026-08-13T06:30:28Z
7. PR #123033 - merged_at 2026-08-13T06:29:30Z
8. PR #123024 - merged_at 2026-08-13T06:25:41Z
9. PR #122992 - merged_at 2026-08-13T06:24:28Z
10. PR #121170 - merged_at 2026-08-13T06:17:33Z

## Output contract
CSV columns: pr_number, committer, reviewer, merger
- pr_number: the PR number (integer)
- committer: the PR author / who committed the code (GitHub username of PR opener)
- reviewer: GitHub username(s) of reviewer(s) who reviewed/approved (as shown on PR page); if multiple, join with "; "; if none, "none"
- merger: GitHub username who merged the PR (from "X merged commit ... into main" message)

Also: full-page screenshot of each PR's page saved to artifacts/screenshots/pr_<number>.png
