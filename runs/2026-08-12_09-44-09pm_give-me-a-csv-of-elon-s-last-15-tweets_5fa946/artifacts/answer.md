# Elon Musk (@elonmusk) Recent Tweets — Collection Notes

## Requested
A CSV of Elon Musk's last 15 tweets with number of likes and time posted.

## What was actually collected
X (Twitter) restricts the logged-out view of any profile to a very small number of
posts before showing a "Log in or sign up" wall. On https://x.com/elonmusk without
being logged in, only **5 posts** were visible/loadable at all (4 in the normal
reverse-chronological timeline, plus 1 currently "Pinned" post), even after
scrolling repeatedly. No further posts loaded — the page consistently rendered the
login wall in place of additional content.

I attempted to log in with the stored X/Twitter credentials to get past this
restriction and reach a full 15-tweet history, but X returned:

> "We've temporarily limited your login. Please try again later."

This is a temporary block imposed by X on the login attempt itself (likely
automated-login / rate-limit protection), not something bypassable with the
available tools (no CAPTCHA solving, no SMS/email code entry, no "sign in with
Google/Apple" credential available). I asked the user how to proceed; the question
was dismissed without a selection, so I proceeded with the best obtainable,
verifiable data rather than fabricating additional rows.

## Deliverables produced
- `artifacts/elon_musk_tweets.csv` — the 5 posts that were actually visible and
  verifiable from @elonmusk's profile (this is fewer than the requested 15 because
  of the platform restriction described above). Columns: `tweet_url`, `likes`,
  `time_posted` (relative time as displayed by X at the moment of collection, e.g.
  "12 minutes ago"), and `text` (post content, where a plain caption was visible).
- `artifacts/elonmusk_profile_screenshot.png` — full-page screenshot of the
  logged-out profile view as evidence of exactly what was visible/available at
  collection time, including the login wall that capped further content.

## Recommendation
To get the full "last 15 tweets," a session logged into X (e.g. resolving the
temporary login limitation, or manually completing login/2FA/CAPTCHA in the
browser) is required, since X's public/logged-out view does not expose that much
history. I'm available to continue and expand the CSV to 15 rows once a working
logged-in session is available.
