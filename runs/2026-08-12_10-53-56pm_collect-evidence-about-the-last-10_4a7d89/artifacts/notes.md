# OpenClaw — Last 10 Merged Pull Requests: Evidence Notes

Repository: https://github.com/openclaw/openclaw

## Method

1. Identified candidate recently-merged PRs via the GitHub UI search
   `is:pr is:merged sort:updated-desc` on
   https://github.com/openclaw/openclaw/pulls
2. Because "recently updated" is not identical to "recently merged" (post-merge
   label/comment activity can bump a PR's "updated" timestamp), each candidate
   PR's exact `merged_at` timestamp, author (`user.login`), and `merged_by.login`
   were retrieved from the GitHub REST API
   (`https://api.github.com/repos/openclaw/openclaw/pulls/{number}`) and cross
   checked against the timestamp shown on each PR's own page.
3. Candidates were ranked by `merged_at` descending; the top 10 by actual merge
   time were selected as "the last 10 merged pull requests."

## Result: top 10 by merged_at (descending)

| rank | pr_number | merged_at (UTC) | author/committer | merged_by |
|---|---|---|---|---|
| 1 | 121192 | 2026-08-13T05:28:13Z | Alix-007 | vincentkoc |
| 2 | 123011 | 2026-08-13T05:25:00Z | RomneyDa | RomneyDa |
| 3 | 121179 | 2026-08-13T05:23:59Z | Leon-SK668 | vincentkoc |
| 4 | 123012 | 2026-08-13T05:20:10Z | steipete | steipete |
| 5 | 123013 | 2026-08-13T05:19:50Z | steipete | steipete |
| 6 | 123001 | 2026-08-13T05:19:46Z | steipete | steipete |
| 7 | 123007 | 2026-08-13T05:14:47Z | vincentkoc | vincentkoc |
| 8 | 122945 | 2026-08-13T05:11:44Z | vincentkoc | vincentkoc |
| 9 | 122990 | 2026-08-13T05:08:43Z | RomneyDa | RomneyDa |
| 10 | 123000 | 2026-08-13T05:07:57Z | vincentkoc | vincentkoc |

Note: PR numbers are not monotonic with merge time in this repository — it has
a very large, actively-worked backlog (thousands of open PRs), so PRs are
merged out of creation-number order depending on maintainer review queue.

## "committer" and "reviewer" definitions used

- **committer**: the PR author, i.e. the GitHub user who opened the pull
  request and whose commit(s) were landed (`user.login` from the API / the
  "by <user>" byline on the PR page). All 10 PRs were merged via squash by
  GitHub, and in every case the person who opened the PR is the person
  credited for the commit.
- **reviewer**: the contents of each PR's "Reviewers" side panel on its GitHub
  page. For all 10 PRs this panel reads **"No reviews"** — no human or GitHub
  Team reviewer was formally requested/recorded. Each PR does receive an
  automated comment from a bot named **ClawSweeper** ("🦞🧹 ClawSweeper picked
  this up" / "ClawSweeper status: review started") which performs an
  AI-assisted review pass as a PR comment, but it is not registered as a
  GitHub "reviewer" (it does not appear in the Reviewers panel or submit a
  formal GitHub review). This is reported verbatim as "No reviews" to reflect
  what is actually shown on each PR page, per the evidence screenshots.
- **merger**: the GitHub user shown as having merged the pull request
  (`merged_by.login` from the API / the "<user> merged commit ... into main"
  event on the PR page).

## Evidence screenshots

Full-page screenshots of each of the 10 pull request pages are included as
PNG files in this artifacts folder:

- pr_121192.png
- pr_123011.png
- pr_121179.png
- pr_123012.png
- pr_123013.png
- pr_123001.png
- pr_123007.png
- pr_122945.png
- pr_122990.png
- pr_123000.png

## Deliverable

- `openclaw_last10_merged_prs.csv` — CSV with columns `pr_number, committer,
  reviewer, merger` describing the 10 pull requests above.
