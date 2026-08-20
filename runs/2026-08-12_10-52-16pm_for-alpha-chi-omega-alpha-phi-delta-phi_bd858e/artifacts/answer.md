# Google Sheet URL

**No Google Sheet could be created.** This browser session has no active Google
sign-in and no stored Google credentials are available in this environment
(the `fill_credentials` tool reported: "No credentials stored for
accounts.google.com"). Google Sheets requires an authenticated Google account
to create a new spreadsheet (https://sheets.new redirects to the Google
sign-in page), and this environment does not support pausing for a human to
complete an interactive login. As a result, I was not able to produce a
Google Sheet URL for this task.

## What was completed instead

All requested research was completed and the full dataset was compiled into
`artifacts/sorority_members.csv`, using exactly the requested columns:
`name, class, major, affiliation, interests, other`. That file is the
authoritative, complete record of all findable data and should be treated as
the deliverable in place of the (unreachable) Google Sheet. If Google
credentials are supplied or a signed-in browser session is made available,
the same CSV data can be imported into a new Google Sheet (File > Import) in
one step.

## Sources used (official chapter sites, found via web search)

- **Alpha Chi Omega**: https://axo.mit.edu/sisters/ — only Class of 2027–2030
  are listed on the public sisters page; no Class of 2026 (seniors) section
  exists on this page, so no AXO seniors could be found. Only names given
  (no major/affiliation/interests/other).
- **Alpha Phi**: https://aphi.mit.edu/sisterhood/2026 and
  https://aphi.mit.edu/sisterhood/2027 — Class of 2026 page lists names only;
  Class of 2027 page lists name, hometown, and major for each sister.
- **Delta Phi Epsilon**: http://dphie.mit.edu/sisterhood/meet-the-sisters/ —
  flip-card profiles list name, major (MIT course number), hometown, and
  class year for each sister (2026 and 2027 both present, though the 2027
  class only has 3 listed members).
- **Kappa Alpha Theta**: https://www.theta.mit.edu/2026s and
  https://www.theta.mit.edu/2027s — detailed profiles with hometown, major,
  big/little sister, and campus activities/interests for each sister.
- **Pi Beta Phi**: https://mit.pibetaphi.org/members — only Class of
  2027–2029 are listed; no Class of 2026 (seniors) section exists on this
  page, so no Pi Phi seniors could be found. Only names given (no
  major/affiliation/interests/other). One entry labeled "PRC" appeared to be
  a placeholder/non-name and was excluded.
- **Sigma Kappa**: https://www.sigmakappa.mit.edu/class-of-2026 and
  https://www.sigmakappa.mit.edu/class-of-2027 — detailed profiles with
  hometown, major, and campus activities/interests for each sister.

## Notes on data limitations

- Not every chapter's public website exposes a Class of 2026 (senior) roster;
  Alpha Chi Omega and Pi Beta Phi's current public sisters pages begin at
  Class of 2027, so no 2026 seniors are recorded for those two chapters in
  the CSV.
- Where a chapter site did not publish major, affiliation, interests, or
  hometown/other information, those cells were left blank in the CSV rather
  than guessed or fabricated.
- "PRC" appeared as a placeholder name (likely standing in for a member who
  opted out of publishing her name/photo, e.g. Panhellenic Recruitment
  Chair/confidential status) on several chapter sites; it was excluded as a
  roster entry but is preserved verbatim inside "affiliation" text (e.g. as
  a listed Big/Little) where it appeared in that context on the Kappa Alpha
  Theta pages.
