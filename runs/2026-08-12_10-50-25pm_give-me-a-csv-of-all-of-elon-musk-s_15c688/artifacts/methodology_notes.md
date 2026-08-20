# Methodology Notes: Elon Musk's tweets posted "today"

**Source:** https://x.com/elonmusk (viewed unauthenticated/logged out)

**"Today" defined as:** Aug 12, 2026, the calendar date of the most recent posts visible
on the profile at time of collection (confirmed via each post's full timestamp, e.g.
"8:41 AM · Aug 12, 2026" shown on the individual status page).

**Posts included:** All 5 posts visible on the profile timeline were dated Aug 12, 2026,
and are included in the CSV. No posts from other dates ("yesterday", etc.) appeared in the
visible window.

**Important limitation:** X.com's logged-out view only renders a handful of the most
recent posts (5, in this case) before presenting a "Log in or sign up" wall that blocks
further scrolling into profile history. It's possible additional posts existed earlier
today that scrolled past this limit and were not retrievable without authentication.
This CSV reflects only the posts visible on the unauthenticated profile page.

**Like counts:** Taken from each individual post's detail page (exact figures, e.g. "3K",
"26K") and converted to plain integers in the CSV (e.g. 3000, 26000) per standard X
abbreviation (K = thousand). These are approximate as displayed by X's own UI rounding.

**Time posted:** Extracted from each post's detail page timestamp, converted to
YYYY-MM-DD HH:MM (24-hour) format, in the timezone X displayed to the browser session.

**One entry with no real caption text:** One post (9:37 PM) was a video repost/quote of
another user (Mike Lee) and had no genuine caption — X displayed a bare media link as
its "text" field. This is noted in the CSV as "[video post - no caption text]" plus the
link, rather than omitted, to keep the row count accurate to "5 tweets posted today."

## Source posts (status IDs)
1. https://x.com/elonmusk/status/2087565020158992709
2. https://x.com/elonmusk/status/2087602469778166195
3. https://x.com/elonmusk/status/2087668743929487420
4. https://x.com/elonmusk/status/2087760069693997530
5. https://x.com/elonmusk/status/2087760446212522196

## Evidence
- artifacts/elonmusk_profile_screenshot.png — screenshot of profile timeline used for collection
