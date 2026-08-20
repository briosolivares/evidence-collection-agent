# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: verified

## Worker completion report

- Summary: Selected 5 AI-focused companies from the YC Winter 2024 batch (verified directly on ycombinator.com/companies pages, all tagged "ARTIFICIAL INTELLIGENCE" and W24/Active):

1. **Retell AI** — AI phone agents for contact centers (5 founders: Bing Wu, Todd Li, Evie Wang, Weijia Yu, Zexia Zhang)
2. **Marr Labs** — Human-like AI voice agents for phone-based jobs (2 founders: Dave Grannan, Han Shu)
3. **Basepilot** — AI agents automating insurance claims (2 founders: Ken Hendricks, Pascal Wieler)
4. **Magic Hour** — AI video generation platform (2 founders: Runbo Li, David Hu)
5. **Mathos** — AI math problem solver / tutor (1 founder: Tianwei Yue)

Total: 12 founder rows across the 5 companies, matching every active founder listed on each company's official YC page.

Published `artifacts/cold_outreach.csv` with exactly the required columns (`founder_name`, `linkedin_url`, `cold_outreach_email`):
- **founder_name**: full name as listed on the YC company page
- **linkedin_url**: each founder's individual LinkedIn profile URL, pulled directly from the linked profile on their YC founder card
- **cold_outreach_email**: a personalized email for each founder that (a) names the founder, (b) references their specific company and product/tagline, (c) cites a specific detail from that founder's bio (e.g., Dave Grannan's Vlingo/Siri history, Ken Hendricks' fintech scaling experience, Zexia Zhang's Google speech/NLP work), and (d) explicitly asks for a 15-minute call

Validated programmatically: 12 rows, correct 3-column header, all founder_name/linkedin_url pairs unique, all LinkedIn URLs well-formed, and every email contains the "15-minute" call request.

Source: https://www.ycombinator.com/companies?batch=Winter%202024 and each company's individual YC page (retell-ai, marr-labs, basepilot, magic-hour, mathos).

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

- manifest_integrity: All 7 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [cold_outreach_csv] table_shape: artifacts/cold_outreach.csv parsed as csv with exactly 12 data row(s) and columns [founder_name, linkedin_url, cold_outreach_email] in the required order. Every explicitly mechanical rule passed (minimum_row_count, unique).

## Structural findings

None recorded.

## Surfaced artifacts (1)

| filename | sha256 | publicationKind | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- | --- |
| artifacts/cold_outreach.csv | 89c2bcceb4c3d053dbac4c4c457c0a052e561097f2ad9ec2f2d7d3629059c6a9 | file | requested_output | 2026-08-20T18:08:16.724Z | https://www.ycombinator.com/companies?batch=Winter%202024 |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.