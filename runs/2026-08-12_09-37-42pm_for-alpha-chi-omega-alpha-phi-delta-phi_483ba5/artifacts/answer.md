# Google Sheet URL

**A Google Sheet could not be created for this task.** This browser session has no
authenticated Google account available (Google Sheets/Drive both redirected to a
sign-in page requesting an email/password that were not provided to this agent),
so it was not possible to create or publish a live Google Sheet at
`docs.google.com/spreadsheets/...`.

As a complete substitute containing exactly the requested data and columns
(`name, class, major, affiliation, interests, other`), see the local evidence
copy published in this same run: **`artifacts/sorority_members.csv`**.
That file should be imported into Google Sheets (File > Import) to complete
the Google Sheet deliverable once Google account access is available.

## Research notes / caveats

- Google web search (google.com) could not be used directly for this task: every
  query was blocked by Google's automated "unusual traffic" reCAPTCHA/image
  challenge in this environment, which could not be reliably solved. Bing and
  DuckDuckGo were also attempted and either returned broken/irrelevant results
  or were CAPTCHA-blocked. As a working substitute, Marginalia Search
  (https://marginalia-search.com) was used to locate each chapter's official
  website, and each identified domain/URL was then verified by visiting it
  directly in the browser.
- Official chapter websites identified and used as sources:
  - Alpha Chi Omega (MIT chapter): https://axo.mit.edu/ — Sisters page:
    https://axo.mit.edu/sisters/. This page lists only Classes of 2027–2030;
    **no Class of 2026 (senior) section exists on the page**, and no
    major/interest information is given for any member, only names.
  - Alpha Phi (MIT chapter): http://aphi.mit.edu/ — Sisterhood pages:
    http://aphi.mit.edu/sisterhood/2026 and /2027. The 2026 (senior) page
    lists names only (no major/interests). The 2027 (junior) page gives full
    name, hometown, and major for each sister.
  - Delta Phi Epsilon (MIT chapter): http://dphie.mit.edu/ — "Meet the
    Members" page: http://dphie.mit.edu/sisterhood/meet-the-sisters/. Gives
    name, MIT "Course" (major) number, and hometown for Class of 2026 and
    Class of 2027 members.
  - Kappa Alpha Theta (MIT, Zeta Mu chapter): https://www.theta.mit.edu/ —
    Sisters pages: https://www.theta.mit.edu/2026s and
    https://www.theta.mit.edu/2027s. Gives name, hometown, major, and
    activities/interests for each sister. (Note: an older, stale chapter site
    at theta.scripts.mit.edu was found first but only listed classes through
    2017 and was determined not to be current; www.theta.mit.edu is the
    current official site.)
  - Pi Beta Phi (MIT, Massachusetts Gamma chapter): https://mit.pibetaphi.org/
    (found via the chapter locator on the national site, pibetaphi.org). This
    official site has **no public sisters/member roster page with class
    years**; it only publishes a "Leaders" (officers) page with no class-year
    information, and the member directory (BetaBase) requires member login.
    No seniors/juniors could be identified for Pi Beta Phi from public
    sources.
  - Sigma Kappa (MIT, Theta Lambda chapter): https://www.sigmakappa.mit.edu/ —
    Class pages: https://www.sigmakappa.mit.edu/class-of-2026 and
    /class-of-2027. Gives name, hometown, major, and activities/interests for
    each sister.
- MIT "Course" numbers appearing in the major field (e.g., "Course 6-3") are
  MIT's numeric major codes; where given by the source page they have been
  expanded in parentheses using standard MIT course-number-to-major mappings
  (e.g., Course 6-3 = Computer Science and Engineering, Course 20 =
  Biological Engineering, Course 15-3 = Finance, etc.).
- Where a data field (major, interests, or other) was not published on the
  official chapter website, the corresponding CSV cell was left blank rather
  than guessed.
