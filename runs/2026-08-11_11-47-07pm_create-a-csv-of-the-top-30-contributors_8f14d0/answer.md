# Top 30 Contributors to openclaw/openclaw

Source: https://github.com/openclaw/openclaw/graphs/contributors (ranked by commit count, as displayed by GitHub's Contributors insight page for the openclaw/openclaw repository).

Deliverable: `top30_contributors.csv` — columns `github_handle,name,linkedin_url`.

## Notes on data collection
- Contributor ranking and handles were collected directly from the GitHub Contributors graph page (ordered #1–#30 by total commits).
- For each handle, the GitHub profile page was visited to capture the displayed "name" (the profile's display name, which may equal the handle if no display name is set) and to check the profile's link list for a linkedin.com URL.
- Several top contributors are automated/bot accounts rather than individual people:
  - `github-actions[bot]` — GitHub's built-in Actions bot (no public profile/LinkedIn).
  - `clawsweeper[bot]` — a GitHub App (OpenClaw maintainer bot), not a person.
  - `openclaw-clownfish[bot]` — a GitHub App (OpenClaw maintainer bot), not a person.
  - `claude` — Anthropic's Claude Code bot account (name shown as "Claude").
  - `cursoragent` — Cursor's automated coding agent account (name shown as "Cursor Agent").
  These are included because they appear in the Contributors ranking, with their GitHub-displayed name and no LinkedIn URL (none exists/applies).
- Where a contributor's GitHub profile had no display name set, the `name` field shows the same value as `github_handle` (e.g., `Alix-007`, `mushuiyu886`).
- Where a contributor's GitHub profile did not list a LinkedIn URL, the `linkedin_url` field was left blank.
- LinkedIn URLs were taken exactly as listed on each contributor's public GitHub profile "Social accounts" / links section.
