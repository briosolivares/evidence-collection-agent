# OpenClaw GitHub Repository — Last 10 Merged Pull Requests

**Repository:** https://github.com/openclaw/openclaw

## Method

1. Started from the repository's Pull Requests tab, filtered to `is:pr is:merged`.
2. Because merge order on this repository is **not** monotonic with PR number
   (many maintainer branches land out of numeric order — confirmed by directly
   comparing `merged_at` timestamps via the GitHub REST API,
   `api.github.com/repos/openclaw/openclaw/pulls/{number}`), each candidate PR's
   exact `merged_at` timestamp was checked individually rather than relying on
   the PR list's on-screen ordering or PR number.
3. The 10 PRs with the latest `merged_at` timestamps (all on 2026-08-12, UTC) were
   selected as "the last 10 merged pull requests."
4. For each of the 10, reviewer information was checked via
   `GET /repos/openclaw/openclaw/pulls/{number}/reviews` — all 10 returned an
   empty array, i.e. GitHub recorded no formal review (no approval / changes
   requested / review comment) on any of them.
5. A full-page screenshot of each PR's GitHub page was captured.

## Results — Top 10 merged PRs (most recent first)

| Rank | PR # | Title | merged_at (UTC) | Committer/Author | Reviewer | Merger |
|------|------|-------|------------------|-------------------|----------|--------|
| 1 | 122455 | refactor(gateway): extract source-agnostic desktop relay core | 2026-08-12T06:58:07Z | steipete | none recorded | steipete |
| 2 | 122490 | fix(media): let sandboxed agents read staged documents | 2026-08-12T06:52:36Z | obviyus | none recorded | obviyus |
| 3 | 122446 | feat(webui): auto-request notification permission on first chat send | 2026-08-12T06:52:06Z | steipete | none recorded | steipete |
| 4 | 122491 | improve(ci): reuse built dist for Doctor proof | 2026-08-12T06:52:00Z | steipete | none recorded | steipete |
| 5 | 122474 | refactor(agents): delete dead model-selection surface and consolidate compaction targets | 2026-08-12T06:37:16Z | steipete | none recorded | steipete |
| 6 | 122477 | feat(gateway): add /startupz startup probe and fix deployment template admission | 2026-08-12T06:36:35Z | steipete | none recorded | steipete |
| 7 | 122487 | test(core): remove residual duplicate cases | 2026-08-12T06:34:32Z | steipete | none recorded | steipete |
| 8 | 122458 | refactor: consolidate coercion contracts | 2026-08-12T06:26:38Z | steipete | none recorded | steipete |
| 9 | 122480 | fix(release): accept exact canonical beta Telegram QA candidates | 2026-08-12T06:25:57Z | steipete | none recorded | steipete |
| 10 | 122483 | fix(ai): continue cached OpenAI WebSocket turns | 2026-08-12T06:24:58Z | steipete | none recorded | steipete |

All 10 pull requests were merged by the same GitHub account that authored them
(self-merged); none carries a distinct GitHub-recorded reviewer.

## Deliverables in this run directory

- `pull_requests.csv` — CSV with columns `pr_number, committer, reviewer, merger`
  for the 10 PRs above.
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
- `notes_merge_times.md` — working notes documenting every PR checked, its
  `merged_at` timestamp, author, merger, and review status, showing how the
  final top-10 ranking was derived.
