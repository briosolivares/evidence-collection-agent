# Google Sheet URL

**A Google Sheet could not be created or populated in this session.**

This environment has no stored Google account credentials, and Google Sheets
(`sheets.new` / `docs.google.com`) requires interactive sign-in that cannot be
completed by this automated agent (no credentials on file for
`accounts.google.com`, and interactive human-in-the-loop prompts are not
available in this run).

## What was completed instead

All requested research was completed via web search (Google search was
blocked by a CAPTCHA; DuckDuckGo was used instead to locate each sorority's
official MIT chapter website, per instructions to use a search engine to
identify the sites) and each chapter's official "sisters" page. The full
results — seniors (Class of 2026) and juniors (Class of 2027), with whatever
major/interests/other information was publicly available — have been saved
locally with exactly the required columns (`name, class, major, affiliation,
interests, other`) in:

- `artifacts/sorority_members.csv`

If Google Sheets access is enabled (e.g., by signing in to a Google account
in the browser), that CSV can be imported directly via
File > Import in Google Sheets to produce the requested Sheet, preserving the
exact column structure.

## Per-chapter source notes

- **Alpha Chi Omega** — https://axo.mit.edu/sisters/ — Only Class of 2027
  (juniors) is listed by name; the site's sisters page currently shows
  Classes of 2027–2030 only, with no Class of 2026 (seniors) section at all.
  No major/interests/other info is published on this page (names only).
- **Alpha Phi** — http://aphi.mit.edu/sisterhood/2026 and /2027 — Class of
  2026 (seniors) listed by name only; Class of 2027 (juniors) listed with
  hometown and major.
- **Delta Phi Epsilon** — official site http://dphie.mit.edu/ was returning a
  503 (scripts.mit.edu service unavailable) at time of research, so the
  Wayback Machine capture of
  http://dphie.mit.edu/sisterhood/meet-the-sisters/ from April 25, 2025 was
  used. Lists Class of 2026 (seniors) and Class of 2027 (juniors) with MIT
  course (major) codes and hometowns.
- **Kappa Alpha Theta** — https://www.theta.mit.edu/2026s and /2027s — Rich
  data for both classes: hometown, major, "big"/"little" sisters, and
  activities/interests.
- **Pi Beta Phi** — https://mit.pibetaphi.org/ (current official site) and
  the legacy http://piphi.mit.edu/ — **No public sisters/member roster by
  class year exists.** The current site only has Home, About, Recruitment,
  Alumnae, Caregivers, Calendar, and Leaders (officer positions only, no
  class years given) pages. The full member directory is behind a
  members-only login (betabase.pibetaphi.org) that is not publicly
  accessible. No individual senior/junior member data could be found for
  this chapter.
- **Sigma Kappa** — https://www.sigmakappa.mit.edu/class-of-2026 and
  /class-of-2027 — Rich data for both classes: hometown, major, and
  activities/interests.

## Column mapping used in the CSV

- `name` — sister's full name as listed
- `class` — graduating class year (2026 = senior, 2027 = junior)
- `major` — MIT course/major as published (may be blank if not listed)
- `affiliation` — sorority name (chapter)
- `interests` — clubs/activities/interests as published (may be blank if not
  listed)
- `other` — additional info such as hometown, "big"/"little" sister pairings
  (may be blank if not listed)
