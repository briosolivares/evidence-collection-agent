# Google Sheet URL

**A Google Sheet could not be created in this environment.** No authenticated Google account session was available to the browser (navigating to sheets.new and myaccount.google.com both returned unauthenticated sign-in / marketing pages, with no credentials available to complete a login). Since creating a Google Sheet requires a signed-in Google account, this step could not be completed, and therefore there is no Google Sheet URL to report.

As a substitute deliverable containing the exact same structured data that was to be added to the Sheet, see the local evidence copy:

- `artifacts/sorority_members.csv` — contains all collected records with the exact columns: `name, class, major, affiliation, interests, other`.

## Research notes / methodology

Google Search (google.com) was blocked by a persistent reCAPTCHA "/sorry" interstitial for every query attempted in this session, including plain navigations and typed searches from the Google homepage, so it could not be used directly. Bing also produced unusable/mis-localized results for queries containing the words "Alpha" or "Pi". As a working substitute for identifying official chapter websites, the Marginalia Search engine (search.marginalia.nu) and direct Wikipedia/domain-guessing were used, then each candidate site was verified by loading it directly in the browser (screenshots saved as evidence in artifacts/).

Official MIT chapter websites identified and used as sources:
- **Alpha Chi Omega** (Theta Omicron chapter): https://axo.mit.edu/ — Sisters page: https://axo.mit.edu/sisters/
- **Alpha Phi**: http://aphi.mit.edu/ — Sisterhood pages: http://aphi.mit.edu/sisterhood/2026 and http://aphi.mit.edu/sisterhood/2027
- **Delta Phi Epsilon** (Zeta Delta chapter): http://dphie.mit.edu/ — Sisters page: http://dphie.mit.edu/sisterhood/meet-the-sisters/
- **Kappa Alpha Theta** (Zeta Mu chapter): https://www.theta.mit.edu/ — Sisters pages: https://www.theta.mit.edu/2026s and https://www.theta.mit.edu/2027s
- **Pi Beta Phi** (Massachusetts Gamma chapter): http://piphi.mit.edu/ — public landing page only; the "Sisters Only" roster is gated behind MIT client-certificate authentication (http://piphi.scripts.mit.edu/sistersonly/), and the national pibetaphi.org site has no public chapter roster either. **No publicly accessible sisters/members list could be found for Pi Beta Phi, so no members from this chapter appear in the CSV.**
- **Sigma Kappa** (Theta Lambda chapter): https://www.sigmakappa.mit.edu/ — Members pages: https://www.sigmakappa.mit.edu/class-of-2026 and https://www.sigmakappa.mit.edu/class-of-2027

For each site, the Class of 2026 (senior) and Class of 2027 (junior) sisters pages were located and all publicly listed information (name, major/course, hometown, activities/interests) was transcribed. Where a chapter site did not publish some of these fields (e.g., Alpha Chi Omega and part of Delta Phi Epsilon list names only), those cells were left blank rather than guessed. Alpha Chi Omega's public sisters page does not include a "Class of 2026" section at all (its lists run 2030–2027 only), so no seniors are listed for that chapter.

## Column mapping used in the CSV
- `name`: full name as listed on the chapter site
- `class`: "Class of 2026 (Senior)" or "Class of 2027 (Junior)"
- `major`: MIT course/major as listed (e.g., "Course 6-3"), when published
- `affiliation`: the sorority name
- `interests`: listed campus activities/organizations, when published
- `other`: hometown, when published (prefixed "Hometown:")
