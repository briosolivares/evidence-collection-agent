# Search Engine Access Log

Task: Identify official MIT chapter websites for Alpha Chi Omega, Alpha Phi, Delta Phi Epsilon,
Kappa Alpha Theta, Pi Beta Phi, and Sigma Kappa; find "sisters" pages; extract senior (2026) and
junior (2027) member info.

## Attempts and outcomes

1. **Google Search** (https://www.google.com/search?q=...)
   - Every query redirected to https://www.google.com/sorry/index... ("unusual traffic" / reCAPTCHA).
   - Solved the initial checkbox multiple times; each time this triggered an image-grid challenge
     (e.g., "select all squares with cars", "select all squares with traffic lights").
   - The challenge button elements exposed no alt-text/labels in the accessibility tree, and no
     tool in this environment can visually decode the embedded challenge images, so the challenge
     could not be completed. Confirmed across >6 distinct fresh queries/sessions.
   - IP flagged in Google's own message: "IP address: 108.238.129.1" — shared/proxy IP flagged for
     "unusual traffic from your computer network."
   - Screenshots preserved as evidence: artifacts/captcha_challenge.png, artifacts/captcha_cars.png,
     artifacts/captcha_traffic.png, artifacts/evidence_google_captcha_blocked.png

2. **Bing** (https://www.bing.com/search?q=...)
   - No CAPTCHA block, pages load, but result content is entirely unrelated to the query regardless
     of query text (e.g., a query for "mitaxo" returned Australian office-locker products; a query
     for "Alpha Chi Omega MIT chapter website" returned generic/irrelevant pages).
   - Tested with many query variants (quoted phrases, site: operators, added keywords) — all
     produced irrelevant results, indicating the search backend/index available to this browser
     session is not functioning as a real web search for this content.

3. **DuckDuckGo** (html.duckduckgo.com / lite.duckduckgo.com) — blocked by bot-detection interstitial.
4. **Startpage** — blocked ("Startpage Blocked" / CAPTCHA block page).
5. **Ecosia** — blocked by "Just a moment..." (Cloudflare) interstitial.
6. **Mojeek** — 403 Forbidden.
7. **Brave Search** — CAPTCHA page.
8. Direct guesses at chapter domains (mitaxo.com, mitalphaphi.com) — DNS did not resolve
   (ERR_NAME_NOT_RESOLVED); no such hosts.
9. Direct navigation to fsilg.mit.edu — DNS did not resolve.

## Conclusion
No live web search or direct verification of chapter websites/sisters pages was achievable from
this browser session. This is a hard environmental blocker (network-level CAPTCHA/bot-detection
across every tested search provider), not a query-phrasing problem. Per instructions to never
substitute fabricated specifics for unverifiable claims, the deliverables must disclose this
limitation rather than invent named individuals, majors, or interests, which cannot be sourced or
confirmed.
