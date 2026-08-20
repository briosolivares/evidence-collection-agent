# Merge time research notes (openclaw/openclaw)

Collected via GitHub API (api.github.com/repos/openclaw/openclaw/pulls/{number} and
.../pulls/{number}/reviews). Merge order is NOT monotonic with PR number in this repo
(many parallel maintainer branches merge out of order relative to PR number). All
merge times below are UTC on 2026-08-12.

| PR | merged_at | author (user.login) | merged_by | reviews (GET .../reviews) |
|----|------------------|----------------------|-----------|---------------------------|
| 122491 | 06:52:00 | steipete | steipete | none |
| 122490 | 06:52:36 | obviyus | obviyus | none |
| 122487 | 06:34:32 | steipete | steipete | none |
| 122483 | 06:24:58 | steipete | steipete | none |
| 122480 | 06:25:57 | steipete | steipete | none |
| 122479 | 06:23:26 | steipete | steipete | (not top 10; not checked) |
| 122478 | 06:19:41 | steipete | steipete | (not top 10; not checked) |
| 122477 | 06:36:35 | steipete | steipete | none |
| 122474 | 06:37:16 | steipete | steipete | none |
| 122468 | 06:18:14 | steipete | steipete | (not top 10; not checked) |
| 122467 | 06:04:02 | steipete | steipete | (not top 10; not checked) |
| 122458 | 06:26:38 | steipete | steipete | none |
| 122455 | 06:58:07 | steipete | steipete | none |
| 122454 | 05:56:55 | steipete | steipete | (not top 10; not checked) |
| 122453 | 05:44:41 | steipete | steipete | (not top 10; not checked) |
| 122452 | 06:18:56 | obviyus | obviyus | (not top 10; not checked) |
| 122451 | 05:26:53 | steipete | steipete | (not top 10; not checked) |
| 122447 | 05:12:47 | sjf-oa | sjf-oa (backport onto release branch, not main) | (not top 10; not checked) |
| 122446 | 06:52:06 | steipete | steipete | none |
| 122445 | 05:37:07 | steipete | steipete | (not top 10; not checked) |
| 122441 | 05:26:40 | steipete | steipete | (not top 10; not checked) |
| 122438 | 04:55:49 | obviyus | obviyus | (not top 10; not checked) |
| 122437 | 05:07:35 | steipete | steipete | (not top 10; not checked) |

## FINAL Top 10 most-recently-merged PRs (by merged_at desc)

1. 122455 - 06:58:07 - author steipete - merged_by steipete - no formal review
2. 122490 - 06:52:36 - author obviyus - merged_by obviyus - no formal review
3. 122446 - 06:52:06 - author steipete - merged_by steipete - no formal review
4. 122491 - 06:52:00 - author steipete - merged_by steipete - no formal review
5. 122474 - 06:37:16 - author steipete - merged_by steipete - no formal review
6. 122477 - 06:36:35 - author steipete - merged_by steipete - no formal review
7. 122487 - 06:34:32 - author steipete - merged_by steipete - no formal review
8. 122458 - 06:26:38 - author steipete - merged_by steipete - no formal review
9. 122480 - 06:25:57 - author steipete - merged_by steipete - no formal review
10. 122483 - 06:24:58 - author steipete - merged_by steipete - no formal review

All 10 PRs returned an empty array from GET .../pulls/{n}/reviews, meaning GitHub
recorded no formal review (no approving/requesting-changes/commenting review) on any
of them. Every one of these PRs was merged by the same account that authored/committed
it (self-merge), which is consistent with this repo's heavily automated,
maintainer-authored PR workflow.
