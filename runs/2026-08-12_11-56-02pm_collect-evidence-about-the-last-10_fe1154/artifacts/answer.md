# OpenClaw GitHub Repository — Last 10 Merged Pull Requests

## Summary

Evidence was collected for the **10 most recently merged pull requests** on
`openclaw/openclaw` as of the collection time (verified via the GitHub REST
search API querying `is:pr is:merged` and confirming no PR merged after
`2026-08-13T07:03:20Z` at verification time — the repository merges PRs very
frequently, roughly every few minutes, so ranking by PR number or "updated"
sort order was insufficient; the true `merged_at` timestamp for each
candidate PR was fetched and compared directly).

## Final ranked list (most recent merge first)

| Rank | PR # | Merged At (UTC) | Committer | Reviewer | Merger |
|------|------|------------------|-----------|----------|--------|
| 1 | [#122706](https://github.com/openclaw/openclaw/pull/122706) | 2026-08-13T07:03:20Z | jesse-merhi | copilot-pull-request-reviewer[bot] | jesse-merhi |
| 2 | [#117305](https://github.com/openclaw/openclaw/pull/117305) | 2026-08-13T07:03:10Z | SunnyShu0925 | None | RomneyDa |
| 3 | [#123038](https://github.com/openclaw/openclaw/pull/123038) | 2026-08-13T07:00:59Z | RomneyDa | None | RomneyDa |
| 4 | [#123005](https://github.com/openclaw/openclaw/pull/123005) | 2026-08-13T06:47:29Z | obviyus | None | obviyus |
| 5 | [#123027](https://github.com/openclaw/openclaw/pull/123027) | 2026-08-13T06:45:59Z | vincentkoc | None | vincentkoc |
| 6 | [#122871](https://github.com/openclaw/openclaw/pull/122871) | 2026-08-13T06:39:18Z | fuller-stack-dev | None | fuller-stack-dev |
| 7 | [#123034](https://github.com/openclaw/openclaw/pull/123034) | 2026-08-13T06:37:22Z | vincentkoc | None | vincentkoc |
| 8 | [#122878](https://github.com/openclaw/openclaw/pull/122878) | 2026-08-13T06:34:06Z | joshavant | None | joshavant |
| 9 | [#123019](https://github.com/openclaw/openclaw/pull/123019) | 2026-08-13T06:30:28Z | vincentkoc | None | vincentkoc |
| 10 | [#123033](https://github.com/openclaw/openclaw/pull/123033) | 2026-08-13T06:29:30Z | steipete | None | steipete |

**Notes:**
- **Committer** = the PR author (`user.login` from the GitHub Pull Request API).
- **Reviewer** = a user/bot with a submitted review recorded via the GitHub
  Pull Request Reviews API (`GET /pulls/{number}/reviews`). Nine of the ten
  PRs had **no recorded reviews** (empty reviews array) — this repository's
  workflow relies on automated agent checks (e.g. "Codex review",
  "ClawSweeper review") shown in the PR body rather than formal GitHub
  review approvals, so "None" is reported verbatim where no review exists.
  PR #122706 has one review entry from `copilot-pull-request-reviewer[bot]`
  (state: COMMENTED — the bot noted it could not complete a full review due
  to a reached quota limit, but this is still the only recorded review
  entry for that PR).
- **Merger** = the user who performed the merge (`merged_by.login` from the
  GitHub Pull Request API). In most cases this is the same person as the
  committer (self-merge); #117305 and #123038 were both merged by
  `RomneyDa` even though #117305 was authored by `SunnyShu0925`.

## Deliverables in this run

- `openclaw_merged_prs.csv` — the requested CSV with columns
  `pr_number, committer, reviewer, merger` for the 10 PRs above.
- `pr_122706.png`, `pr_117305.png`, `pr_123038.png`, `pr_123005.png`,
  `pr_123027.png`, `pr_122871.png`, `pr_123034.png`, `pr_122878.png`,
  `pr_123019.png`, `pr_123033.png` — full-page screenshots of each PR's
  GitHub page.
- `pr_123021_EXCLUDED_NOTE.txt` — methodology/audit note explaining a few
  extra screenshots retained from the iterative research process
  (PRs #123021, #123024, #122992, #121170, which were briefly believed to be
  in the top 10 before more exhaustive `merged_at` verification identified
  more recently merged PRs).
