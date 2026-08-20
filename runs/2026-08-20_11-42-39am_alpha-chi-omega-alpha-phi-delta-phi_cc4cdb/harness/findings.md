# findings report

_Audit projection only. Not a requested output, not part of the manifest, never machine-read for control flow._

## Status

- Phase: terminal
- Outcome: incomplete
- Reason: verification_incomplete
- Detail: the evidence judge could not produce a valid verdict: invalid report_verification input: [
  {
    "code": "unrecognized_keys",
    "keys": [
      "kind"
    ],
    "path": [
      "findings",
      0
    ],
    "message": "Unrecognized key: \"kind\""
  },
  {
    "code": "unrecognized_keys",
    "keys": [
      "kind"
    ],
    "path": [
      "findings",
      1
    ],
    "message": "Unrecognized key: \"kind\""
  },
  {
    "code": "unrecognized_keys",
    "keys": [
      "kind"
    ],
    "path": [
      "findings",
      2
    ],
    "message": "Unrecognized key: \"kind\""
  }
]

## Worker completion report

- Summary: I researched all six MIT sororities, located each one's official chapter website and sisters/members page, and compiled seniors (Class of 2026) and juniors (Class of 2027) into a Google Sheet titled "MIT Sorority Sisters - Seniors 2026 and Juniors 2027" at https://docs.google.com/spreadsheets/d/1a7ZkBjXZkg6YrjL7-aa3tQDPkDrdyHlB2zevCiHc6qU/edit — populated via Google Sheets' native CSV Import (File > Import > Upload > Replace current sheet) so the data landed as real parsed columns, not pasted text. The sheet has 211 sister rows plus a header row, with columns Name, Class, Major, Affiliation, Interests, Other.

Per-sorority findings:
- **Alpha Chi Omega** (axo.mit.edu/sisters/): site only lists a Class of 2027 roster (20 names) with photos — no major/interests fields exist on the page, and there is no Class of 2026 section at all (noted explicitly as a placeholder row rather than fabricated).
- **Alpha Phi** (aphi.mit.edu, dedicated /sisterhood/2026 and /sisterhood/2027 pages): 2026 page lists only 20 names (no major/hometown data on that page); 2027 page lists 32 sisters with full major and hometown detail.
- **Delta Phi Epsilon** (dphie.mit.edu/sisterhood/meet-the-sisters/): 9 members under 2026, 3 under 2027, each with course number and hometown.
- **Kappa Alpha Theta** (theta.mit.edu/2026s and /2027s): richest data source — 19 seniors and 24 juniors, each with hometown, major, and activities/interests.
- **Pi Beta Phi** (mit.pibetaphi.org/members): only Classes of 2027/2028/2029 are listed on the live roster (34 names for 2027, no majors/interests fields exist on the page); no Class of 2026 section exists on the site (noted explicitly rather than fabricated).
- **Sigma Kappa** (sigmakappa.mit.edu/class-of-2026 and /class-of-2027): fullest data — 20 seniors and 27 juniors, each with hometown, major, and activities.

Published artifacts:
1. `artifacts/google_sheet_populated.png` — screenshot of the live Google Sheet (top rows, headers visible) as primary requested-output evidence, captured from the actual docs.google.com/spreadsheets URL.
2. `artifacts/google_sheet_populated_middle_rows.png` — screenshot showing rows further down the sheet (Alpha Phi → Delta Phi Epsilon) confirming consistent population across sororities.
3. `artifacts/mit_sorority_sisters_data.csv` — the underlying CSV used to populate the sheet, for auditability.

Known gaps (reported transparently in the sheet rather than fabricated): Alpha Chi Omega's and Pi Beta Phi's public websites do not currently list any Class of 2026 (senior) members — this is a limitation of the source sites' active roster pages, not a research omission (confirmed by inspecting full page text for both sites; no other "seniors" or "class of 2026" page/tab exists on either site). Alpha Chi Omega's and Pi Beta Phi's sisters pages also do not publish major/hometown/interests fields for any class year — only names and photos are shown — so those cells are left blank rather than guessed.

### Unresolved requirements (3)

1. **Alpha Chi Omega: Class of 2026 (senior) sisters with name, class, major, affiliation, interests, other** — The chapter's public sisters page (axo.mit.edu/sisters/) only publishes a Class of 2027 roster; there is no Class of 2026 section, tab, or link anywhere on the site to pull senior data from.
   - Attempts: Loaded axo.mit.edu/sisters/ and read full page text/HTML — confirmed only 'Class of 2027' heading exists, no 'Class of 2026' text anywhere on page; Checked for hidden tabs, additional links, or an alumni/seniors subpage — none found
2. **Alpha Chi Omega and Pi Beta Phi: Major and Interests fields for listed sisters** — Both chapters' sisters/members pages display only sister names and photos with no accompanying major, hometown, or activities/interests text anywhere in the page DOM.
   - Attempts: Inspected full innerText and innerHTML of axo.mit.edu/sisters/ — only names present, no bio fields; Inspected mit.pibetaphi.org/members full text — only names (some marked PRC/private) present, no bio fields; Checked Pi Beta Phi's /leaders page for supplementary bio data — none found
3. **Pi Beta Phi: Class of 2026 (senior) sisters** — The chapter's public members page (mit.pibetaphi.org/members) only lists Class of 2027, 2028, and 2029 rosters; no Class of 2026 section exists on the site.
   - Attempts: Loaded mit.pibetaphi.org/members and confirmed via full-page text search that 'Class of 2026' does not appear anywhere on the page; Checked the /leaders page for any additional senior roster — none found

## Deterministic settled facts

- manifest_integrity: All 14 recorded file(s) named here were opened as regular non-symlink files and matched their manifest SHA-256 values.
- [sorority_sisters_sheet] external_action_proof: 2 verified artifact(s) carry recorded source URLs matching "https://docs.google.com/spreadsheets/d/*", including 1 valid PNG proof screenshot(s): [artifacts/google_sheet_populated.png, artifacts/google_sheet_populated_middle_rows.png]. Only URL provenance is settled; whether the captures show the requested action completed remains yours to judge.
- evidence_screenshots: Verified source-backed evidence screenshot(s): [artifacts/google_sheet_populated.png, artifacts/google_sheet_populated_middle_rows.png].

## Structural findings

None recorded.

## Surfaced artifacts (3)

| filename | sha256 | publicationKind | roles | capturedAt | sourceUrl | completionStatus |
| --- | --- | --- | --- | --- | --- | --- |
| artifacts/google_sheet_populated_middle_rows.png | c47e5747fcf3c4834675ee7b66236418097542f3008974bf07bb9fd7784b8b4e | screenshot | evidence | 2026-08-20T18:50:50.490Z | https://docs.google.com/spreadsheets/d/1a7ZkBjXZkg6YrjL7-aa3tQDPkDrdyHlB2zevCiHc6qU/edit?gid=0#gid=0 |  |
| artifacts/google_sheet_populated.png | 0f1358a5b764317fd180e25d6ed1c3e135a78b4095106c1b42e0e314eabc9954 | screenshot | requested_output, evidence | 2026-08-20T18:50:29.482Z | https://docs.google.com/spreadsheets/d/1a7ZkBjXZkg6YrjL7-aa3tQDPkDrdyHlB2zevCiHc6qU/edit?gid=0#gid=0 |  |
| artifacts/mit_sorority_sisters_data.csv | 91fb17c409d2a2ab74f603c3327f353886bacf606b0371e4896baa84f9618e58 | file | evidence | 2026-08-20T18:50:33.462Z |  |  |

## Current verifier findings

No open verifier findings.

## Prior verification cycles (0)

None recorded.