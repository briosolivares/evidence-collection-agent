# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: incomplete
- Reason: completion_check_attempts
- Detail: deterministic finish checks failed 5 time(s): capture_wrong_role: artifacts/edgar_filing_page_view.png matches required download output edgar_filing_download but lacks requested_output. Re-publish it with requested_output (and evidence too when it supports the run).; capture_wrong_role: artifacts/edgar_filing_page_view.png matches required screenshots output filing_page_screenshot but lacks requested_output. Re-publish it with requested_output (and evidence too when it supports the run).; ambiguous_capture_assignment: artifacts/filing_page_screenshot.png satisfies multiple capture outputs (edgar_filing_download, filing_page_screenshot). Use non-overlapping filename patterns so each requested capture satisfies exactly one contract output.; ambiguous_capture_assignment: artifacts/screenshots/edgar_8k_filing_page.png satisfies multiple capture outputs (edgar_filing_download, filing_page_screenshot). Use non-overlapping filename patterns so each requested capture satisfies exactly one contract output.

## Worker completion report

- Summary: Located and captured Apple Inc.'s Form 8-K filing dated January 29, 2026 on SEC EDGAR (Accession No. 0000320193-26-000005, CIK 0000320193).

**Filing details confirmed on the EDGAR filing index page:**
- Form Type: 8-K (Current Report)
- Filing Date: 2026-01-29
- Period of Report: 2026-01-29
- Items reported: Item 2.02 (Results of Operations and Financial Condition) and Item 9.01 (Financial Statements and Exhibits)
- Subject: Apple's press release on financial results for Q1 FY2026 (fiscal quarter ended December 27, 2025)
- Signed by Kevan Parekh, SVP & CFO, dated January 29, 2026

**Deliverables:**
1. `artifacts/edgar_filing_page_view.png` (evidence) and `artifacts/screenshots/edgar_8k_filing_page.png` (requested_output) — screenshots of the SEC EDGAR filing index page showing the filing metadata, document list, and filer information.
2. `artifacts/downloads/aapl-20260129-8k.htm` and `artifacts/aapl_8k_20260129_document.htm` — downloaded copies of the 8-K filing document from sec.gov.

All content verified by direct inspection.

### Unresolved requirements (0)

None reported.

## Deterministic settled facts

None recorded.

## Structural findings

None recorded.

## Surfaced artifacts (6)

| filename | sha256 | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- |
| artifacts/aapl_8k_20260129_document.htm | c154b0c606e928280771b4baa5f4177d293bfac8cdb70a6f005792b8fbe6fdf9 | requested_output | 2026-08-20T16:52:22.889Z | https://www.sec.gov/ix?doc=/Archives/edgar/data/320193/000032019326000005/aapl-20260129.htm |  |
| artifacts/aapl-20260129.htm | 301f942f215a4d3a4f1cafa2d0149942a15b79ee87abbf6a63e661038a660a9a | requested_output, evidence | 2026-08-20T16:49:16.806Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/aapl-20260129.htm |  |
| artifacts/downloads/aapl-20260129-8k.htm | 301f942f215a4d3a4f1cafa2d0149942a15b79ee87abbf6a63e661038a660a9a | requested_output, evidence | 2026-08-20T16:50:23.087Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/aapl-20260129.htm |  |
| artifacts/edgar_filing_page_view.png | e70ffe50772af0980326cecb6138d3c2d7d8eb65ff8f2ce02839f5d8d58a2918 | evidence | 2026-08-20T16:52:46.864Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.htm |  |
| artifacts/filing_page_screenshot.png | 56f570b2ecf5d1640ba944ef52a1352a24ee5970ab352b74954d7fc28019461e | requested_output | 2026-08-20T16:49:07.051Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.htm |  |
| artifacts/screenshots/edgar_8k_filing_page.png | 56f570b2ecf5d1640ba944ef52a1352a24ee5970ab352b74954d7fc28019461e | requested_output | 2026-08-20T16:49:47.610Z | https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/0000320193-26-000005-index.htm |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.