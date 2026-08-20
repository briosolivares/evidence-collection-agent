# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: verified

## Worker completion report

- Summary: Selected 5 AI-focused companies from the YC Winter 2024 batch (all verified directly from ycombinator.com/companies pages):

1. **Marr Labs** — AI-voice agents indistinguishable from humans (founders: Dave Grannan, Han Shu)
2. **RetailReady** — AI-powered supply chain compliance engine (founders: Elle Smyth, Sarah Hamer)
3. **kater.ai** — AI data analysis agent, "Butler" (founders: Yvonne Chou, Robin Seitz)
4. **Mathos** — AI math problem solver / personalized learning (founder: Tianwei Yue)
5. **Dragoneye** — Custom video detection models in <5 minutes (founder: Alex Liao)

Produced `cold_outreach.csv` (published as `artifacts/cold_outreach.csv`) with exactly the requested columns: `founder_name`, `linkedin_url`, `cold_outreach_email`. It contains 8 rows — one per founder across the five companies (all co-founders included, not just one per company). All founder_name + linkedin_url pairs are unique. Each LinkedIn URL was pulled directly from that founder's profile link on their company's official YC page. Each cold_outreach_email is personalized with specific, verifiable details about that founder's background (e.g., Dave Grannan's Vlingo/Siri history, Sarah Hamer's Stord experience, Robin Seitz's Microsoft/Abbott/Paragon background) and their company's specific product/traction (Vox Mortgage, the $3.3M RetailReady raise, Kater's Butler agent, Mathos's 1M+ students and Forbes 30u30, Dragoneye's zero-shot Playground) — and every email explicitly requests a 15-minute call.

Also published `artifacts/evidence_yc_company_pages.json` containing the raw scraped text from each company's official YC page as supporting evidence for the founder names, bios, and company details used to personalize each email.

Note: LinkedIn URLs were sourced from YC's official company pages rather than independently verified by loading each LinkedIn profile (LinkedIn generally requires authentication to view profiles), so I did not screenshot each individual profile — but the URLs are the exact links YC itself publishes for each founder.

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

- manifest_integrity: All 5 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [cold_outreach_csv] table_shape: artifacts/cold_outreach.csv parsed as csv with exactly 8 data row(s) and columns [founder_name, linkedin_url, cold_outreach_email] in the required order. Every explicitly mechanical rule passed (minimum_row_count, unique).

## Structural findings

None recorded.

## Surfaced artifacts (2)

| filename | sha256 | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- |
| artifacts/cold_outreach.csv | 04bfb9fa3135b9e4850caeeec9e7a3f484040f0fdf8b9c7377ae471e9c1de868 | requested_output | 2026-08-20T16:55:59.509Z | https://www.ycombinator.com/companies?batch=Winter%202024 |  |
| artifacts/evidence_yc_company_pages.json | 6f3eadc9de65ab9debc28f45e573cbd3ea0c338fe36392f8325532e2f5e5c2c3 | evidence | 2026-08-20T16:56:03.095Z | https://www.ycombinator.com/companies?batch=Winter%202024 |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.