import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { githubHeaders } from './githubApi.js';

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
});

describe('githubHeaders', () => {
  it('omits Authorization when GITHUB_TOKEN is unset', () => {
    delete process.env.GITHUB_TOKEN;
    const headers = githubHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).not.toBe('');
  });

  it('omits Authorization when GITHUB_TOKEN is blank', () => {
    process.env.GITHUB_TOKEN = '   ';
    expect(githubHeaders().Authorization).toBeUndefined();
  });

  it('sends a bearer Authorization when GITHUB_TOKEN is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    expect(githubHeaders().Authorization).toBe('Bearer ghp_testtoken');
  });
});
