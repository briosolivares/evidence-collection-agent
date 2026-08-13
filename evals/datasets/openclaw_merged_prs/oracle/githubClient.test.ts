import { describe, expect, it } from 'vitest';

import {
  MERGED_WINDOW_SIZE,
  parseCommitIdentities,
  parseMergedBy,
  parseMergedPullsResponse,
  parseReviewers,
} from './githubClient.js';

function pullJson(number: number, mergedAt: string | null, login = `user-${number}`): unknown {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
    merged_at: mergedAt,
    user: { login },
  };
}

describe('parseMergedPullsResponse', () => {
  it('drops unmerged closes and sorts by mergedAt descending', () => {
    const prs = parseMergedPullsResponse([
      pullJson(1, '2026-08-11T01:00:00Z'),
      pullJson(2, null), // closed without merging
      pullJson(3, '2026-08-11T03:00:00Z'),
      pullJson(4, '2026-08-11T02:00:00Z'),
    ]);
    expect(prs.map((p) => p.number)).toEqual([3, 4, 1]);
    expect(prs[0]!.author).toBe('user-3');
  });

  it('caps the window at MERGED_WINDOW_SIZE', () => {
    const many = Array.from({ length: MERGED_WINDOW_SIZE + 10 }, (_, i) =>
      pullJson(i + 1, `2026-08-11T00:${String(i % 60).padStart(2, '0')}:00Z`),
    );
    expect(parseMergedPullsResponse(many)).toHaveLength(MERGED_WINDOW_SIZE);
  });

  it('throws on a non-array response', () => {
    expect(() => parseMergedPullsResponse({ message: 'rate limited' })).toThrow(/array/);
  });

  it('throws on a merged entry missing user.login', () => {
    const bad = { ...(pullJson(7, '2026-08-11T00:00:00Z') as object), user: null };
    expect(() => parseMergedPullsResponse([bad])).toThrow(/user\.login/);
  });
});

describe('parseMergedBy', () => {
  it('extracts the merging login', () => {
    expect(parseMergedBy({ merged_by: { login: 'the-merger' } })).toBe('the-merger');
  });

  it('returns undefined when absent', () => {
    expect(parseMergedBy({ merged_by: null })).toBeUndefined();
  });
});

describe('parseReviewers', () => {
  it('returns distinct submitter logins, excluding the PR author', () => {
    const reviews = [
      { user: { login: 'alice' }, state: 'APPROVED' },
      { user: { login: 'the-author' }, state: 'COMMENTED' },
      { user: { login: 'alice' }, state: 'COMMENTED' },
      { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
      { user: null, state: 'COMMENTED' },
    ];
    expect(parseReviewers(reviews, 'the-author')).toEqual(['alice', 'bob']);
  });

  it('throws on a non-array response', () => {
    expect(() => parseReviewers({}, 'x')).toThrow(/array/);
  });
});

describe('parseCommitIdentities', () => {
  it('returns distinct logins and git names across all commits, in order', () => {
    const commits = [
      {
        author: { login: 'steipete' },
        committer: { login: 'ampagent' },
        commit: { author: { name: 'Peter S' }, committer: { name: 'ampagent' } },
      },
      {
        author: null,
        committer: { login: 'ampagent' },
        commit: { author: { name: 'Peter S' }, committer: { name: '' } },
      },
    ];
    expect(parseCommitIdentities(commits)).toEqual(['steipete', 'ampagent', 'Peter S']);
  });

  it('throws on a non-array response', () => {
    expect(() => parseCommitIdentities({})).toThrow(/array/);
  });
});
