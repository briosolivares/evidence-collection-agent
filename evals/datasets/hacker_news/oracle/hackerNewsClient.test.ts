import { describe, expect, it } from 'vitest';

import { parseItem, parseTopStoryIds } from './hackerNewsClient.js';

// Canned Firebase API response fixtures — no network access, mirroring the
// real shapes of GET /v0/topstories.json and GET /v0/item/<id>.json.
const TOP_STORIES_FIXTURE = [111, 222, 333, 444, 555, 666, 777];

const ITEM_WITH_URL_FIXTURE = {
  id: 111,
  type: 'story',
  by: 'pg',
  title: 'A New Programming Language',
  url: 'https://example.com/article',
  score: 250,
  descendants: 80,
};

const ASK_HN_ITEM_FIXTURE = {
  id: 222,
  type: 'story',
  by: 'dang',
  title: 'Ask HN: What are you working on?',
  score: 90,
  descendants: 300,
  // no "url" field — a text/self post
};

describe('parseTopStoryIds', () => {
  it('returns the ids in the order the API listed them', () => {
    expect(parseTopStoryIds(TOP_STORIES_FIXTURE)).toEqual(TOP_STORIES_FIXTURE);
  });

  it('throws when the response is not an array of numbers', () => {
    expect(() => parseTopStoryIds({ not: 'an array' })).toThrow(/array of numbers/);
    expect(() => parseTopStoryIds(['111', '222'])).toThrow(/array of numbers/);
  });
});

describe('parseItem', () => {
  it('extracts title, url, and score from an item with an external url', () => {
    expect(parseItem(ITEM_WITH_URL_FIXTURE, 111)).toEqual({
      id: 111,
      title: 'A New Programming Language',
      url: 'https://example.com/article',
      score: 250,
    });
  });

  it('falls back to the HN item permalink when the item has no url', () => {
    expect(parseItem(ASK_HN_ITEM_FIXTURE, 222)).toEqual({
      id: 222,
      title: 'Ask HN: What are you working on?',
      url: 'https://news.ycombinator.com/item?id=222',
      score: 90,
    });
  });

  it('throws naming the item id when title is missing', () => {
    expect(() => parseItem({ score: 10 }, 999)).toThrow(/item 999.*title/);
  });

  it('throws naming the item id when score is not a number', () => {
    expect(() => parseItem({ title: 'x', score: 'high' }, 999)).toThrow(/item 999.*score/);
  });

  it('throws when the response is not an object', () => {
    expect(() => parseItem(null, 1)).toThrow(/not an object/);
    expect(() => parseItem('nope', 1)).toThrow(/not an object/);
  });
});
