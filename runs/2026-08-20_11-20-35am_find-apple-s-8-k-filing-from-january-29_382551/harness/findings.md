# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: verified

## Worker completion report

- Summary: Located and verified Apple Inc.'s 8-K filing on SEC EDGAR with a Date of Report of January 29, 2026 (accession number 0000320193-26-000005, CIK 0000320193). This filing reports Item 2.02 "Results of Operations and Financial Condition" — Apple's press release regarding financial results for its first fiscal quarter ended December 27, 2025 — signed by Kevan Parekh, SVP & CFO.

Deliverables published:
1. **artifacts/aapl-20260129_8-K.htm** (download, requested_output + evidence) — the actual filing document downloaded directly from SEC EDGAR at https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/aapl-20260129.htm. Verified content shows FORM 8-K, "January 29, 2026" as Date of Report, Registrant "Apple Inc.", Item 2.02 disclosure, and the exhibit reference to the Q1 2026 earnings press release (Exhibit 99.1).

2. **artifacts/filing_page_screenshot.png** (screenshot, requested_output + evidence) — a full-page screenshot of the SEC EDGAR filing index page at https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.html, clearly showing "Apple Inc." as the filer, Form type 8-K, and Filing Date 01/29/2026, along with the list of filing documents including the main 8-K document and its press-release exhibit.

Both artifacts were sourced directly from sec.gov, satisfying the sourceUrlPattern requirement, and the screenshot visually confirms the required elements: Apple's 8-K filing page on SEC EDGAR and the January 29, 2026 filing date.

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

- manifest_integrity: All 3 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [sec_edgar_filing_download] download_shape: 1 valid requested download artifact(s) satisfied the contract: [artifacts/aapl-20260129_8-K.htm]. Their recorded source URLs and inferred byte formats passed deterministic checks.
- [filing_page_screenshot] screenshots_shape: 1 valid requested screenshot artifact(s) satisfied the contract: [artifacts/filing_page_screenshot.png]. Their recorded source URLs and inferred byte formats passed deterministic checks.
- evidence_screenshots: Verified source-backed evidence screenshot(s): [artifacts/filing_page_screenshot.png].

## Structural findings

None recorded.

## Surfaced artifacts (2)

| filename | sha256 | publicationKind | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- | --- |
| artifacts/aapl-20260129_8-K.htm | 301f942f215a4d3a4f1cafa2d0149942a15b79ee87abbf6a63e661038a660a9a | download | requested_output, evidence | 2026-08-20T18:21:35.872Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/aapl-20260129.htm |  |
| artifacts/filing_page_screenshot.png | 5011b484fd63c89bdec55708d589cd881cdbca2ea4cf55c78f55a16a1f99e91a | screenshot | requested_output, evidence | 2026-08-20T18:21:14.454Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.html |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.