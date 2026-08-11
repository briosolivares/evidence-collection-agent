/**
 * Typed client for the Hacker News (Firebase) API: topstories.json plus
 * per-item lookups. Parsing is split from fetching so the parse logic can be
 * unit-tested against canned JSON without any network access — only the
 * `fetch*` functions at the bottom of this file touch the network, and the
 * automated suite never calls them.
 */

/** Base URL of the Hacker News Firebase API (v0). */
const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';

/** Number of top stories the eval task asks for. */
export const HN_TOP_STORY_COUNT = 5;

/** One Hacker News story, as the oracle reports it. */
export interface HackerNewsStory {
  /** The story's Hacker News item id. */
  id: number;
  /** The story's title, verbatim. */
  title: string;
  /** The story's link: its external `url` when present, otherwise the
   *  HN item's own permalink (Hacker News' own convention for link-less
   *  posts like "Ask HN"). */
  url: string;
  /** The story's current point score. */
  score: number;
}

/** Ground truth for the Hacker News task: the current top N stories. */
export interface HackerNewsOracle {
  /** The top stories, in leaderboard rank order. */
  stories: HackerNewsStory[];
}

/**
 * Parse a `topstories.json` response into an ordered list of item ids.
 *
 * @param json - the parsed JSON body of a `GET /v0/topstories.json` response
 * @returns the story ids in rank order
 * @throws if `json` is not an array of numbers
 */
export function parseTopStoryIds(json: unknown): number[] {
  if (!Array.isArray(json) || !json.every((id) => typeof id === 'number')) {
    throw new Error('topstories.json response must be an array of numbers');
  }
  return json;
}

/**
 * Parse an `item/<id>.json` response into a typed story.
 *
 * @param json - the parsed JSON body of a `GET /v0/item/<id>.json` response
 * @param id - the item id the response was fetched for, used to build the
 *   permalink fallback and included in error messages
 * @returns the story, with `url` falling back to the item's own HN
 *   permalink (`https://news.ycombinator.com/item?id=<id>`) when the item
 *   has no external `url` field (e.g. an "Ask HN" post)
 * @throws if `json` is not an object with a string `title` and numeric
 *   `score`
 */
export function parseItem(json: unknown, id: number): HackerNewsStory {
  if (typeof json !== 'object' || json === null) {
    throw new Error(`item ${id}: response is not an object`);
  }
  const obj = json as { title?: unknown; score?: unknown; url?: unknown };
  if (typeof obj.title !== 'string') {
    throw new Error(`item ${id}: missing or non-string "title"`);
  }
  if (typeof obj.score !== 'number') {
    throw new Error(`item ${id}: missing or non-number "score"`);
  }
  if (obj.url !== undefined && typeof obj.url !== 'string') {
    throw new Error(`item ${id}: "url" must be a string when present`);
  }
  return {
    id,
    title: obj.title,
    score: obj.score,
    url: obj.url ?? itemPermalink(id),
  };
}

/** The permalink Hacker News itself uses for a story with no external link. */
function itemPermalink(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

/**
 * Fetch the current top N Hacker News stories from the live Firebase API.
 * Not called anywhere in the automated test suite — it is the one live-HTTP
 * seam this module exposes, exercised only by `oracle/oracle.ts` at grading
 * time and by demos.
 *
 * @returns the oracle for the Hacker News task: the current top
 *   `HN_TOP_STORY_COUNT` stories in rank order
 * @throws if the API is unreachable or returns a response `parseTopStoryIds`
 *   / `parseItem` cannot parse
 */
export async function fetchHackerNewsOracle(): Promise<HackerNewsOracle> {
  const topStoriesResponse = await fetch(`${HN_API_BASE}/topstories.json`);
  const ids = parseTopStoryIds(await topStoriesResponse.json()).slice(0, HN_TOP_STORY_COUNT);

  const stories = await Promise.all(
    ids.map(async (id) => {
      const itemResponse = await fetch(`${HN_API_BASE}/item/${id}.json`);
      return parseItem(await itemResponse.json(), id);
    }),
  );
  return { stories };
}
