# MIT Sorority Members — Seniors (Class of 2026) & Juniors (Class of 2027)

## Google Sheet URL

**A Google Sheet could not be created in this run.** This environment has no stored Google
account credentials, and the automated `ask_user_question` interactive-login pause is not
supported here, so I was unable to sign in to Google Sheets to create and populate a sheet.

As a complete substitute, all of the requested data (with the exact columns `name, class,
major, affiliation, interests, other`) has been compiled into the local evidence CSV file:

- `artifacts/sorority_members.csv`

If Google Sheets access is enabled for a future run (or credentials are supplied), that CSV
can be imported directly into Google Sheets (File > Import > Upload) to produce the requested
Sheet without any reformatting, since its columns already match the required schema exactly.

## Sources used (official MIT chapter websites, found via Google)

1. **Alpha Chi Omega** — https://axo.mit.edu (sisters roster: /sisters/). Live site was
   unreachable during this run; data captured via Wayback Machine snapshot
   (https://web.archive.org/web/20250918053933/https://axo.mit.edu/sisters/).
2. **Alpha Phi** — http://aphi.mit.edu (sisterhood rosters: /sisterhood/2026, /sisterhood/2027).
   Live site was unreachable during this run; data captured via Wayback Machine snapshots.
3. **Delta Phi Epsilon** — http://dphie.mit.edu (roster: /sisterhood/meet-the-sisters/). Live
   site was unreachable during this run; data captured via Wayback Machine snapshot HTML.
4. **Kappa Alpha Theta** — https://www.theta.mit.edu (rosters: /2026s, /2027s). Live site
   accessible; data captured directly from page HTML.
5. **Pi Beta Phi** — https://mit.pibetaphi.org (roster: /members). Live site accessible. Note:
   as of this run the page only lists Class of 2027, 2028, and 2029 — the Class of 2026
   (seniors) has already been removed from the roster (graduated), so **no senior data is
   available** for Pi Beta Phi.
6. **Sigma Kappa** — https://www.sigmakappa.mit.edu (rosters: /class-of-2026, /class-of-2027).
   Live site accessible; data captured directly from page HTML.

## Notes on data completeness

- Only members explicitly identified as Class of 2026 (seniors) or Class of 2027 (juniors) on
  each chapter's own roster page are included.
- Entries labeled "PRC" (Privacy Requested / not publicly listed) on the source rosters were
  excluded, since they are placeholders rather than named members.
- Field availability varies by chapter website: Kappa Alpha Theta and Sigma Kappa publish rich
  profiles (major/course number, hometown, big/little, activities/interests). Alpha Chi Omega,
  Alpha Phi, and Pi Beta Phi list names only (no major/interests data available on their sites).
  Delta Phi Epsilon lists names plus course/major for most members. Where a field was not
  published on the source site, it was left blank in the CSV rather than guessed.
- The `class` column values used are "Senior (Class of 2026)" and "Junior (Class of 2027)" to
  make both the class year and standing explicit and consistent across all six chapters.
- The `interests` column captures each chapter's "Activities" listing when published; the
  `other` column captures any remaining published details (hometown, big/little pairings).

## Deliverables produced in this run

- `artifacts/sorority_members.csv` — full evidence dataset, columns: name, class, major,
  affiliation, interests, other (206 member rows across the 6 chapters' available senior/junior
  rosters).
- `artifacts/answer.md` — this file.
- Supporting raw HTML captures and screenshots for audit trail (e.g.
  `artifacts/theta_2026s_raw.html`, `artifacts/theta_2027s_raw.html`,
  `artifacts/sigmakappa_2026_raw.html`, `artifacts/sigmakappa_2027_raw.html`,
  `artifacts/pibetaphi_members_raw.html`, `artifacts/dphie_raw.html`,
  `artifacts/dphie_meet_sisters_screenshot1.png`, `artifacts/dphie_2026_2027_view.png`).
