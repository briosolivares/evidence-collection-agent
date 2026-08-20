# Evidence: Last 10 Merged Pull Requests — openclaw/openclaw

Source: https://github.com/openclaw/openclaw/pulls?q=is%3Apr+is%3Amerged (sorted by most recently merged)

The 10 most recently merged pull requests, in order from most recent to 10th most recent, are:

1. #122491 — improve(ci): reuse built dist for Doctor proof
2. #122490 — fix(media): let sandboxed agents read staged documents
3. #122487 — test(core): remove residual duplicate cases
4. #122483 — fix(ai): continue cached OpenAI WebSocket turns
5. #122480 — fix(release): accept exact canonical beta Telegram QA candidates
6. #122479 — refactor(discord): split voice lifecycle ownership
7. #122478 — test(agents): remove exact duplicate cases
8. #122477 — feat(gateway): add /startupz startup probe and fix deployment template admission
9. #122474 — refactor(agents): delete dead model-selection surface and consolidate compaction targets
10. #122468 — fix(agents): keep concurrent isolated completions independent

## Deliverables

- `pull_requests.csv` — CSV with columns `pr_number, committer, reviewer, merger` for all 10 PRs.
- `screenshots/pr_122491.png` — full-page screenshot of PR #122491
- `screenshots/pr_122490.png` — full-page screenshot of PR #122490
- `screenshots/pr_122487.png` — full-page screenshot of PR #122487
- `screenshots/pr_122483.png` — full-page screenshot of PR #122483
- `screenshots/pr_122480.png` — full-page screenshot of PR #122480
- `screenshots/pr_122479.png` — full-page screenshot of PR #122479
- `screenshots/pr_122478.png` — full-page screenshot of PR #122478
- `screenshots/pr_122477.png` — full-page screenshot of PR #122477
- `screenshots/pr_122474.png` — full-page screenshot of PR #122474
- `screenshots/pr_122468.png` — full-page screenshot of PR #122468

## Notes on data collection

For each PR, the "committer" is taken as the pull request author (the user who opened/committed the changes), the "merger" is the GitHub user who performed the merge action (shown in the "X merged commit ... into main" event and the page header "X merged N commit(s) into main"), and "reviewer" reflects the value of the page's "Reviewers" panel in the right sidebar. All 10 PRs in this window show "No reviews" in the Reviewers panel — meaning no GitHub-recorded human/team review was requested or submitted through GitHub's review feature (each was authored and self-merged by a maintainer, sometimes with automated bot commentary from ClawSweeper, but that bot activity is not a formal GitHub PR review). These are recorded as "None" in the CSV.
