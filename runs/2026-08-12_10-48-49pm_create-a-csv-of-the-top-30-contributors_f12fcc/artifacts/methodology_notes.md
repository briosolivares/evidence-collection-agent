# Methodology Notes — OpenClaw Top 30 Contributors

**Source:** https://github.com/openclaw/openclaw/graphs/contributors (GitHub's contributor
ranking graph, ranked by commit count as displayed by GitHub, captured live).

**Process:**
1. Loaded the contributors graph page and scrolled to load all entries; recorded the
   ranked list of the first 30 GitHub handles (#1–#30) as shown by GitHub's own ranking.
2. Visited each contributor's public GitHub profile page (`github.com/<handle>`) to read
   the displayed name (shown in the page `<title>` as `handle (Display Name)`) and to look
   for a LinkedIn URL among the profile's social/bio links.
3. Where no LinkedIn link was present on the public GitHub profile (or the account has no
   display name), the `linkedin_url` and/or `name` field was left blank rather than guessed.
4. Several top-30 entries are automated/bot or AI-agent accounts rather than individual
   people, per GitHub's own listing: `github-actions[bot]` (#5, GitHub's own Actions bot),
   `clawsweeper[bot]` (#9, the "ClawSweeper" GitHub App), `claude` (#8, Anthropic's Claude
   Code bot account), `ampagent` (#16, the "Amp" coding agent), and
   `openclaw-clownfish[bot]` (#22, the "OpenClaw Clownfish" GitHub App). These are included
   as-is since the task asked for the top 30 contributors per the repository's contributor
   ranking, with no LinkedIn URL applicable.
5. `Alix-007` (#10) has no public display name set on GitHub, so `name` is left blank.

**Deliverable:** `artifacts/openclaw_top30_contributors.csv` — columns
`github_handle, name, linkedin_url`, one row per contributor rank 1–30.

**Evidence:** `artifacts/contributors_page_evidence.png` — screenshot of the GitHub
contributors graph page used as the ranking source.
