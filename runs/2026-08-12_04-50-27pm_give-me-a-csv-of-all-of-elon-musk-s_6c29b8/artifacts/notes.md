# Notes on Data Collection: Elon Musk's Tweets Posted Today

**Source:** https://x.com/elonmusk (viewed without logging in)

**Method:** Loaded the profile page and inspected the "Posts" tab. X.com only renders a
handful of posts (1 pinned + 4 in the reverse-chronological feed) to unauthenticated
visitors before showing a "See Elon Musk's full profile — Log in or sign up" wall that
blocks further scrolling/loading. No login credentials were available in this session,
so this is the complete set of Elon Musk's own posts that could be retrieved.

**Determining "today":** All 5 retrieved posts show relative timestamps (1h, 5h, 5h, 6h,
8h) rather than a calendar date. X.com switches from relative "Xh" timestamps to an
absolute date once a post is more than 24 hours old (and typically once it crosses into
a prior calendar day for well-known accounts' recent activity). Since none of these
posts show a date and all fall within an 8-hour window with no gap or date marker
between them and the present, they are treated as posted today. The pinned post also
carries an "8h" timestamp, consistent with today.

**Exclusions:** Quoted/retweeted posts by other accounts (SpaceXAI, ivanzhouyq,
yunta_tsai, EMostaque) that appeared embedded inside Elon Musk's posts were excluded —
only Elon Musk's own authored text and engagement stats were captured, per the CSV's
`text` column.

**Likes values:** Recorded exactly as displayed by X's UI (abbreviated, e.g. "18K",
"2.6K"), since X does not expose exact like counts to unauthenticated viewers.

**Deliverable:** `artifacts/elonmusk_tweets_today.csv` — columns: text, likes, time_posted.

**Evidence:** `artifacts/elonmusk_tweets_evidence.png` (full-page screenshot of the
profile as loaded) and `artifacts/elonmusk_profile_initial.png` (initial viewport
screenshot).
