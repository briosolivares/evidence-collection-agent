# Google Sheet URL

**A Google Sheet could not be created in this session.** No Google account is logged in in the
browser, and no stored Google credentials are available to this agent (the `fill_credentials`
tool reported "No credentials stored for accounts.google.com"). Since creating/editing a Google
Sheet requires an authenticated Google account, and no human was available to complete an
interactive login in this run, this step could not be completed.

**All of the collected data has been saved locally instead**, in `artifacts/sorority_members.csv`,
with exactly the requested columns: `name, class, major, affiliation, interests, other`. That file
can be imported directly into Google Sheets (File → Import → Upload) to produce the requested
Google Sheet once a Google login is available.

## Research method note
Google web search (`google.com`) blocked automated queries with a persistent "unusual traffic"
CAPTCHA challenge that could not be reliably solved without human input. As a substitute search
engine (same goal: identify each sorority's official MIT website via web search), DuckDuckGo
(`duckduckgo.com`) was used instead. This is documented in case it affects verification of the
"use Google" step of the task.

## Sources used (official chapter websites, "Sisters"/"Sisterhood" pages)
- Alpha Chi Omega (MIT): https://axo.mit.edu/sisters/ — only classes 2027–2030 listed publicly;
  **no Class of 2026 (senior) roster is published** on this page.
- Alpha Phi (MIT): https://aphi.mit.edu/sisterhood/2026 and https://aphi.mit.edu/sisterhood/2027
- Delta Phi Epsilon (MIT): http://dphie.mit.edu/sisterhood/meet-the-sisters/ (2026 and 2027 sections)
- Kappa Alpha Theta (MIT): https://www.theta.mit.edu/2026s and https://www.theta.mit.edu/2027s
- Pi Beta Phi (MIT): https://mit.pibetaphi.org/members — only classes 2027–2029 listed publicly;
  **no Class of 2026 (senior) roster is published** on this page. A few member photos on this page
  are placeholders (labeled "PRC") with no name attached; these were excluded as they are not
  identifiable individuals.
- Sigma Kappa (MIT): https://www.sigmakappa.mit.edu/class-of-2026 and
  https://www.sigmakappa.mit.edu/class-of-2027

Only the information each chapter's own public sisters page chose to publish is included (e.g.
some chapters list only a name; others include hometown, major/course number, and activities).
Where a page used "Big/Little" family or hometown information without a distinct field for
"interests" vs. other notes, activities/clubs were placed in `interests` and
hometown/family/course-note details were placed in `other`.
