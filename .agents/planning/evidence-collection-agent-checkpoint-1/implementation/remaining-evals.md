# Remaining visible eval datasets — build record

Implemented 2026-08-12 at the user's direction. Together with the five existing real packages, the six packages below complete all eleven visible design-doc evals. This work only builds and verifies dataset packages; it does **not** run a new model baseline.

## Packages and grading contracts

| Design row | Dataset | Independent/structural oracle | Automated assertions | Human overlay that remains |
| --- | --- | --- | --- | --- |
| 4 | `company_freshness` | Notion official article metadata, Figma official JSON Feed, Eight Sleep official blog cards; newest three items per company form a churn window | Six real PNGs; homepage URL provenance for each company; one content URL in each live freshness window; homepage/content artifacts distinct; manifest hashes | Screenshot pixels genuinely show the intended page; newest content across alternate official press channels |
| 5 | `yc_w24_outreach` | Fresh public search-only credentials from YC's official Startup and Founder directories; two Algolia queries joined by company slug | Exact columns; complete/distinct rows; every founder is attached to a W24 AI-tagged company; exactly five companies and every public founder included; personal LinkedIn URL shape/name consistency; company/founder/detail personalization plus 15-minute ask; manifest hashes | LinkedIn profile ownership where slugs are unusual; prose quality and whether the personalization is persuasive |
| 7 | `elon_tweets` | Tier-B run-time contract (no unauthenticated X completeness API) | Exact columns; plausible row count; non-empty distinct text; non-negative integer/compact like counts; same-day, time-of-day, or relative time values; manifest hashes | @elonmusk authorship, completeness, reply/repost semantics, and the X UI's displayed counts |
| 9 | `wikipedia_reference` | Official MediaWiki parse API; locate displayed `[275]`, follow its reference-list target, then its `CITEREF…` Sources target | Manifested `answer.md`; full normalized highlighted Sources text present; no truncation marker and sufficient length; manifest hashes | Minor rendering fidelity (italics, em dashes, hyperlink styling) |
| 10 | `airbnb_lake_tahoe` | Tier-B run-date/location/stay contract (Airbnb results are personalized and cookie-sensitive) | Manifested `answer.md`; exact numbered sequence 1–30; distinct valid `/rooms/<id>` URLs; substantive identity/summary per item; seven-night pair starting 1–14 days after run; Lake Tahoe + substantive overall summary; manifest hashes | Exact first-30 ranking, current availability/prices, and factual summary fidelity |
| 11 | `mit_sororities` | Tier-B fixed affiliation/class contract (chapter rosters vary; output Sheet is private) | Manifested `sorority_members.csv` and `answer.md` Google Sheet URL; exact six columns; plausible row bounds; all six affiliations × both classes represented; plausible unique full names; minimum major and interests/other coverage; manifest hashes | Official-site identity/roster accuracy and equality between the local evidence copy and private Google Sheet |

## Output-contract clarifications

The original intent is preserved, but task text makes the durable deliverable explicit where the original conversational wording was not machine-gradeable:

- Airbnb requires `answer.md`, an ordered 30-item list, listing URLs, exact stay dates, and an overall summary.
- MIT requires the Google Sheet plus a local `sorority_members.csv` evidence copy and an `answer.md` Sheet URL receipt. The local copy has exactly the six user-named columns.
- Wikipedia requires the natural-language answer in `answer.md`.
- YC names the exact normalized CSV headers and makes one-row-per-founder explicit.

These clarifications are necessary because graders receive only the run directory; they never inspect the transcript or final chat message.

## Verification

- Each new grader has passing, malformed/missing-output, semantic-failure, provenance-tamper, and malformed-oracle coverage appropriate to its contract.
- Live oracle smoke checks succeeded for all independent sources on 2026-08-12:
  - Wikipedia resolved displayed reference 275 to `CITEREFBeevor2012`.
  - YC returned 157 W24 AI-tagged companies with public founder records (337 founders at smoke-check time).
  - Notion, Figma, and Eight Sleep each returned a three-item current content window.
- Every one of the eleven real dataset names loads through `loadEvalTask`.
- `npm run typecheck`: clean.
- Full hermetic suite: 547/547 tests across 216 suites.

No baseline or re-baseline was run; the standing user-direction requirement still applies.
