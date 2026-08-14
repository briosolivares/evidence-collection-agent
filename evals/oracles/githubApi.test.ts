import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let savedToken: string | undefined;

// Re-imported per test rather than at the top of the file: the missing-token
// warning is once-per-process by design, so asserting on it needs module
// state that no earlier test has already tripped.
let githubHeaders: typeof import('./githubApi.js').githubHeaders;

beforeEach(async () => {
  savedToken = process.env.GITHUB_TOKEN;
  vi.resetModules();
  ({ githubHeaders } = await import('./githubApi.js'));
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
});

describe('githubHeaders', () => {
  it('omits Authorization when GITHUB_TOKEN is unset', () => {
    delete process.env.GITHUB_TOKEN;
    const headers = githubHeaders(() => undefined);
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).not.toBe('');
  });

  it('omits Authorization when GITHUB_TOKEN is blank', () => {
    process.env.GITHUB_TOKEN = '   ';
    expect(githubHeaders(() => undefined).Authorization).toBeUndefined();
  });

  it('sends a bearer Authorization when GITHUB_TOKEN is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    expect(githubHeaders().Authorization).toBe('Bearer ghp_testtoken');
  });

  it('warns once that an unauthenticated batch will fail grading, naming the fix', () => {
    delete process.env.GITHUB_TOKEN;
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    githubHeaders(warn);
    githubHeaders(warn);
    githubHeaders(warn);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GITHUB_TOKEN is not set');
    // The 2026-08-14 batch was misread as an agent regression; the warning
    // has to say where the failure lands and how to load the token.
    expect(warnings[0]).toMatch(/403/);
    expect(warnings[0]).toMatch(/npm run evals|--env-file-if-exists=\.env/);
  });

  it('stays silent when the token is present', () => {
    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    const warnings: string[] = [];
    githubHeaders((message) => warnings.push(message));
    expect(warnings).toEqual([]);
  });

  it('warns on the first unauthenticated call even after authenticated ones', () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    process.env.GITHUB_TOKEN = 'ghp_testtoken';
    githubHeaders(warn);
    expect(warnings).toEqual([]);

    delete process.env.GITHUB_TOKEN;
    githubHeaders(warn);
    expect(warnings).toHaveLength(1);
  });
});
