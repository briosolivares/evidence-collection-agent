# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: verified

## Worker completion report

- Summary: Collected evidence on the last 10 merged pull requests from the openclaw/openclaw GitHub repository (found via GitHub search, since "OpenClaw" resolves to https://github.com/openclaw/openclaw).

**Methodology:**
- Used GitHub's PR search with `is:pr is:merged sort:merged-desc` to get pull requests ordered by most recent merge date.
- Verified via `relative-time` timestamps on several PR pages that this ordering matches true chronological merge order (e.g., #126743 merged 9:49 AM, #126741 at 9:48 AM, #126740 at 9:39 AM, down to #126717 at 8:52 AM — all correctly descending).
- The 10 most recently merged PRs identified: #126743, #126741, #126740, #126736, #126734, #126723, #126722, #126719, #126718, #126717.
- For each PR, extracted: the author/committer (from the PR header), the "Reviewers" sidebar section, and the merge attribution line ("X merged commit ... into main") from the timeline.

**Findings:**
- 9 of the 10 PRs were authored, reviewed (none requested), and self-merged by user `steipete`.
- 1 PR (#126740) was authored and self-merged by `RomneyDa`.
- None of the 10 PRs had a formal review recorded in GitHub's Reviewers panel (shown as "No reviews" in each case) — verified this directly against page content for multiple PRs, not just inferred.

**Deliverables published:**
1. `artifacts/openclaw_merged_prs.csv` — CSV with exactly 10 rows and columns `pr_number, committer, reviewer, merger`, one row per PR, matching the exact-row-count and unique pr_number requirements.
2. 10 full-page screenshots, one per PR, at `artifacts/screenshots/pr_<number>.png` for PRs 126743, 126741, 126740, 126736, 126734, 126723, 126722, 126719, 126718, 126717 — each captured directly from its live GitHub PR page (source URLs recorded).
3. `artifacts/evidence/pr_data_extracted.json` — raw extracted author/reviewer/merger text per PR as supporting evidence.

All data was extracted directly from the live GitHub pages (no fabrication); the "No reviews" and self-merge pattern was independently spot-checked against on-page text for PR #126740 to confirm the parsing was accurate rather than an artifact of extraction logic.

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

- manifest_integrity: All 14 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [pr_screenshots] screenshots_shape: 10 valid requested screenshot artifact(s) satisfied the contract: [artifacts/screenshots/pr_126743.png, artifacts/screenshots/pr_126741.png, artifacts/screenshots/pr_126740.png, artifacts/screenshots/pr_126736.png, artifacts/screenshots/pr_126734.png, artifacts/screenshots/pr_126723.png, artifacts/screenshots/pr_126722.png, artifacts/screenshots/pr_126719.png, artifacts/screenshots/pr_126718.png, artifacts/screenshots/pr_126717.png]. Their recorded source URLs and inferred byte formats passed deterministic checks.
- [pr_csv] table_shape: artifacts/openclaw_merged_prs.csv parsed as csv with exactly 10 data row(s) and columns [pr_number, committer, reviewer, merger] in the required order. Every explicitly mechanical rule passed (exact_row_count, unique).

## Structural findings

None recorded.

## Surfaced artifacts (12)

| filename | sha256 | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- |
| artifacts/evidence/pr_data_extracted.json | 071c183ca6ff4f0baa38914f5a921edb4b3f2633ef37e27b6239e5e107215fff | evidence | 2026-08-20T16:56:29.849Z | https://github.com/openclaw/openclaw/pulls?q=is%3Apr+is%3Amerged+sort%3Amerged-desc |  |
| artifacts/openclaw_merged_prs.csv | 5359da90d5a11897d7db0fcf2ef938c06d29a488c10bfd4f9e66126813a3ce64 | requested_output | 2026-08-20T16:56:25.994Z | https://github.com/openclaw/openclaw/pulls?q=is%3Apr+is%3Amerged+sort%3Amerged-desc |  |
| artifacts/screenshots/pr_126717.png | cc6766ff53f5836723eaa5a09c50afbf42fe7f6eb4c653df0fc27fb858fdc400 | requested_output | 2026-08-20T16:56:05.971Z | https://github.com/openclaw/openclaw/pull/126717 |  |
| artifacts/screenshots/pr_126718.png | 145db510e4887813aa979e9cac37f690b6cd20370dd0e0ffacba636daa1f4899 | requested_output | 2026-08-20T16:55:57.109Z | https://github.com/openclaw/openclaw/pull/126718 |  |
| artifacts/screenshots/pr_126719.png | c76e8becab1fedb5dc0bafc697ef1a13470eb95501ec793d4e7cedbee69b4cce | requested_output | 2026-08-20T16:55:47.632Z | https://github.com/openclaw/openclaw/pull/126719 |  |
| artifacts/screenshots/pr_126722.png | 48f01a165ff7e6ca162060c74a3f744aaee3f189f28ce9257d9aa1984f7a72b2 | requested_output | 2026-08-20T16:55:38.982Z | https://github.com/openclaw/openclaw/pull/126722 |  |
| artifacts/screenshots/pr_126723.png | 389db72fc50ec598b21bef00b3d68e987f8304fc4bf5026693f69f23dd2d902a | requested_output | 2026-08-20T16:55:29.527Z | https://github.com/openclaw/openclaw/pull/126723 |  |
| artifacts/screenshots/pr_126734.png | 20a90da23ca244571b95b84065a7000033ab270e04f878ea10262d7f146d53dd | requested_output | 2026-08-20T16:55:20.784Z | https://github.com/openclaw/openclaw/pull/126734 |  |
| artifacts/screenshots/pr_126736.png | 84a5df4ccaeb2951f8a6078d9e305e6e1bfbf76f64b9022b5a37a34639433fb2 | requested_output | 2026-08-20T16:55:11.564Z | https://github.com/openclaw/openclaw/pull/126736 |  |
| artifacts/screenshots/pr_126740.png | 1e93b7b589c277116cabea83011d312f00100182d57cb9354f1be7df23389bb3 | requested_output | 2026-08-20T16:55:02.819Z | https://github.com/openclaw/openclaw/pull/126740 |  |
| artifacts/screenshots/pr_126741.png | b4990577959d2ecdd7bc354e3f859587bfd7ba62bc7491f08dc2deee1232dd24 | requested_output | 2026-08-20T16:54:54.759Z | https://github.com/openclaw/openclaw/pull/126741 |  |
| artifacts/screenshots/pr_126743.png | 20c5327a3609bb854d443ec9c9e27b46451b2284e852b1a105dc827dbc2a6bd3 | requested_output | 2026-08-20T16:54:46.395Z | https://github.com/openclaw/openclaw/pull/126743 |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.