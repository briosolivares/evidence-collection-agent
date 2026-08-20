# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: verified

## Worker completion report

- Summary: Created `artifacts/openclaw_top_contributors.csv` listing the top 30 contributors to the OpenClaw GitHub repository (https://github.com/openclaw/openclaw), ranked by commit count per GitHub's own `/graphs/contributors` page (which I paged/scrolled through and parsed to confirm rank #1–#30 exactly as rendered by GitHub).

Methodology:
1. Identified the canonical `openclaw/openclaw` repository (387k+ stars) as distinct from an unrelated older "OpenClaw" game-engine repo.
2. Loaded `/graphs/contributors`, scrolled to force full lazy-load of the contributor list, and extracted handle, commit count, and displayed rank (#1–#100) directly from rendered text.
3. Took the first 30 ranked entries as the "top 30 contributors."
4. Visited each contributor's GitHub profile page individually to capture their displayed name and any LinkedIn URL present in their profile links.
5. Corrected two false-positive LinkedIn matches that were actually GitHub's own footer link (for `github-actions[bot]` and `openclaw-clownfish[bot]`, both automated bot accounts with no real profile) — left those blank.

Result: 30 unique rows, all with `github_handle` filled (required field). `name` is populated for every account except one that has genuinely set no display name (`Alix-007`) and the two bot accounts. `linkedin_url` is populated only where a contributor explicitly links a LinkedIn profile on their GitHub profile (8 of 30) — this is expected since most GitHub users don't publish that link, and it is an optional column.

Note: several top contributors are automated/bot or AI-agent accounts (e.g., `github-actions[bot]`, `claude`, `ampagent`, `clawsweeper[bot]`, `openclaw-clownfish[bot]`) that legitimately rank in the top 30 by commit count on this repo — they are included as GitHub reports them, with blank name/LinkedIn since those fields don't meaningfully apply.

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

- manifest_integrity: All 5 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [openclaw_top_contributors] table_shape: artifacts/openclaw_top_contributors.csv parsed as csv with exactly 30 data row(s) and columns [github_handle, name, linkedin_url] in the required order. Every explicitly mechanical rule passed (exact_row_count, unique).

## Structural findings

None recorded.

## Surfaced artifacts (1)

| filename | sha256 | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- |
| artifacts/openclaw_top_contributors.csv | 05b1234d5d17b51b1e3e2db2aab4e212a02033a9e2cb47bb308f8d510b9d5d3f | requested_output | 2026-08-20T16:52:06.269Z | https://github.com/openclaw/openclaw/graphs/contributors |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.