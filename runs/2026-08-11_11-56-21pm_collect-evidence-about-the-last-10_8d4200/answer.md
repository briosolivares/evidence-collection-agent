# Last 10 Merged Pull Requests — openclaw/openclaw

## Methodology
- Repository confirmed from initial page context: https://github.com/openclaw/openclaw
- Used the GitHub REST API (`/repos/openclaw/openclaw/pulls?state=closed&sort=updated&direction=desc`) to retrieve
  candidate closed pull requests along with their `merged_at` timestamps, since the GitHub web UI's PR search only
  offers sort by "Newest" (created date), "Recently updated", etc., and does not offer a direct "sort by merge date"
  option. Filtering to PRs with a non-null `merged_at` and sorting descending by that timestamp yields the true
  most-recently-merged 10 pull requests.
- For each of the 10 PRs, fetched the individual PR API endpoint (`/repos/openclaw/openclaw/pulls/{number}`) to get
  the author (`user.login`, used as "committer") and `merged_by.login` (used as "merger").
- For each of the 10 PRs, fetched `/repos/openclaw/openclaw/pulls/{number}/reviews` to determine formal reviewers;
  all 10 returned an empty array (`[]`), and this was cross-checked visually on PR pages, which show "No reviews"
  under the Reviewers sidebar section for these PRs. Reviewer is therefore recorded as "None" for all 10.
- Took a full-page screenshot of each of the 10 pull request pages on github.com as evidence (saved under
  `screenshots/`).

## Last 10 merged PRs (most recent first, by merged_at UTC)
| pr_number | title | merged_at (UTC) | committer | reviewer | merger |
|---|---|---|---|---|---|
| 122455 | refactor(gateway): extract source-agnostic desktop relay core | 2026-08-12T06:58:07Z | steipete | None | steipete |
| 122490 | fix(media): let sandboxed agents read staged documents | 2026-08-12T06:52:36Z | obviyus | None | obviyus |
| 122446 | feat(webui): auto-request notification permission on first chat send | 2026-08-12T06:52:06Z | steipete | None | steipete |
| 122491 | improve(ci): reuse built dist for Doctor proof | 2026-08-12T06:52:00Z | steipete | None | steipete |
| 122474 | refactor(agents): delete dead model-selection surface and consolidate compaction targets | 2026-08-12T06:37:16Z | steipete | None | steipete |
| 122477 | feat(gateway): add /startupz startup probe and fix deployment template admission | 2026-08-12T06:36:35Z | steipete | None | steipete |
| 122487 | test(core): remove residual duplicate cases | 2026-08-12T06:34:32Z | steipete | None | steipete |
| 122458 | refactor: consolidate coercion contracts | 2026-08-12T06:26:38Z | steipete | None | steipete |
| 122480 | fix(release): accept exact canonical beta Telegram QA candidates | 2026-08-12T06:25:57Z | steipete | None | steipete |
| 122483 | fix(ai): continue cached OpenAI WebSocket turns | 2026-08-12T06:24:58Z | steipete | None | steipete |

## Notes
- "committer" = the pull request author (the GitHub user whose branch/commits were merged), taken from the PR's
  `user.login` field.
- "reviewer" = GitHub user(s) who submitted a formal review via the Reviews API; all 10 PRs had none (fast-moving,
  maintainer-merged, largely single-participant PRs), so this column is "None" for every row.
- "merger" = the GitHub user who performed the merge action, taken from the PR's `merged_by.login` field.
- This repository merges pull requests very rapidly (multiple PRs merged within the same hour), which is why a
  precise `merged_at` timestamp (rather than the UI's relative-time "Newest" sort, which sorts by creation date)
  was required to correctly identify the true last 10 merged PRs.

## Deliverables
- `pull_requests.csv` — CSV with columns `pr_number, committer, reviewer, merger` for the 10 PRs above.
- `screenshots/pr_122455.png`
- `screenshots/pr_122490.png`
- `screenshots/pr_122446.png`
- `screenshots/pr_122491.png`
- `screenshots/pr_122474.png`
- `screenshots/pr_122477.png`
- `screenshots/pr_122487.png`
- `screenshots/pr_122458.png`
- `screenshots/pr_122480.png`
- `screenshots/pr_122483.png`
- `raw/` — supporting raw API JSON responses used to determine merge order, authors, mergers, and reviews
  (`pulls_closed_recent.json`, `pr_<number>.json`, `reviews_<number>.json`) and `sort_analysis.md` documenting the
  sort derivation.
