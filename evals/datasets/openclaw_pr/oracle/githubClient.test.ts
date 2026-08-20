import { describe, expect, it } from 'vitest';

import {
  acceptablePrsInWindow,
  parsePullRequestsResponse,
  type GithubPullRequest,
} from './githubClient.js';

// Canned GitHub REST API fixture — a `GET .../pulls` response, deliberately
// listed out of created-at order to prove the parser sorts rather than
// trusting the API's ordering.
const PULLS_RESPONSE_FIXTURE = [
  {
    number: 41,
    title: 'Fix flaky retry test',
    html_url: 'https://github.com/openclaw/openclaw/pull/41',
    created_at: '2026-01-05T10:00:00Z',
  },
  {
    number: 42,
    title: 'Add streaming support',
    html_url: 'https://github.com/openclaw/openclaw/pull/42',
    created_at: '2026-01-10T10:00:00Z',
  },
  {
    number: 40,
    title: 'Bump dependencies',
    html_url: 'https://github.com/openclaw/openclaw/pull/40',
    created_at: '2026-01-01T10:00:00Z',
  },
];

describe('parsePullRequestsResponse', () => {
  it('sorts pull requests by createdAt descending regardless of input order', () => {
    const prs = parsePullRequestsResponse(PULLS_RESPONSE_FIXTURE);
    expect(prs.map((p) => p.number)).toEqual([42, 41, 40]);
  });

  it('maps html_url and created_at to url and createdAt', () => {
    const [first] = parsePullRequestsResponse(PULLS_RESPONSE_FIXTURE);
    expect(first).toEqual({
      number: 42,
      title: 'Add streaming support',
      url: 'https://github.com/openclaw/openclaw/pull/42',
      createdAt: '2026-01-10T10:00:00Z',
    });
  });

  it('throws when the response is not an array', () => {
    expect(() => parsePullRequestsResponse({ not: 'an array' })).toThrow(/array/);
  });

  it('throws naming the index when an entry is missing a required field', () => {
    expect(() => parsePullRequestsResponse([{ number: 1, title: 'x' }])).toThrow(/pulls\[0\]/);
  });
});

describe('acceptablePrsInWindow', () => {
  const prs: GithubPullRequest[] = [
    { number: 10, title: 'Old PR', url: 'u10', createdAt: '2026-01-01T00:00:00Z' },
    { number: 11, title: 'Was newest at run start', url: 'u11', createdAt: '2026-01-05T00:00:00Z' },
    { number: 12, title: 'Created mid-run', url: 'u12', createdAt: '2026-01-10T12:00:00Z' },
    { number: 13, title: 'Created after run ended', url: 'u13', createdAt: '2026-01-20T00:00:00Z' },
  ];
  const startedAt = '2026-01-10T00:00:00Z';
  const finishedAt = '2026-01-10T23:59:59Z';

  it('includes the PR that was newest at run start, plus any created during the run', () => {
    const acceptable = acceptablePrsInWindow(prs, startedAt, finishedAt);
    expect(acceptable.map((p) => p.number).sort()).toEqual([11, 12]);
  });

  it('excludes a PR created after the run finished', () => {
    const acceptable = acceptablePrsInWindow(prs, startedAt, finishedAt);
    expect(acceptable.some((p) => p.number === 13)).toBe(false);
  });

  it('excludes a PR that was already stale before run start', () => {
    const acceptable = acceptablePrsInWindow(prs, startedAt, finishedAt);
    expect(acceptable.some((p) => p.number === 10)).toBe(false);
  });

  it('is inclusive of a PR created exactly at startedAt', () => {
    const boundaryPrs: GithubPullRequest[] = [
      { number: 1, title: 'At boundary', url: 'u1', createdAt: startedAt },
    ];
    expect(acceptablePrsInWindow(boundaryPrs, startedAt, finishedAt).map((p) => p.number)).toEqual([
      1,
    ]);
  });

  it('is inclusive of a PR created exactly at finishedAt', () => {
    const boundaryPrs: GithubPullRequest[] = [
      { number: 1, title: 'Before', url: 'u1', createdAt: '2026-01-01T00:00:00Z' },
      { number: 2, title: 'At end boundary', url: 'u2', createdAt: finishedAt },
    ];
    expect(acceptablePrsInWindow(boundaryPrs, startedAt, finishedAt).map((p) => p.number)).toEqual([
      1, 2,
    ]);
  });

  it('returns an empty list when no PR existed by startedAt and none were created during the run', () => {
    const futureOnly: GithubPullRequest[] = [
      { number: 1, title: 'Far future', url: 'u1', createdAt: '2099-01-01T00:00:00Z' },
    ];
    expect(acceptablePrsInWindow(futureOnly, startedAt, finishedAt)).toEqual([]);
  });

  it('throws when startedAt or finishedAt does not parse as a date', () => {
    expect(() => acceptablePrsInWindow(prs, 'not-a-date', finishedAt)).toThrow(/startedAt/);
    expect(() => acceptablePrsInWindow(prs, startedAt, 'not-a-date')).toThrow(/finishedAt/);
  });
});
