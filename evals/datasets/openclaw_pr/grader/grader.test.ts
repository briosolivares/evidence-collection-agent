import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeArtifact } from '../../../../src/run/artifacts.js';
import type { GithubPullRequest, OpenClawPrOracle } from '../oracle/githubClient.js';
import { grade } from './grader.js';

const RUN_STARTED_AT = '2026-01-10T00:00:00Z';
const RUN_FINISHED_AT = '2026-01-10T12:00:00Z';

const PR_MOST_RECENT_AT_START: GithubPullRequest = {
  number: 10,
  title: 'Fix retry backoff',
  url: 'https://github.com/openclaw/openclaw/pull/10',
  createdAt: '2026-01-05T00:00:00Z', // before the run started
};
const PR_CREATED_MID_RUN: GithubPullRequest = {
  number: 11,
  title: 'Add streaming download support',
  url: 'https://github.com/openclaw/openclaw/pull/11',
  createdAt: '2026-01-10T06:00:00Z', // inside [startedAt, finishedAt]
};
const PR_CREATED_AFTER_RUN: GithubPullRequest = {
  number: 12,
  title: 'Unrelated later change',
  url: 'https://github.com/openclaw/openclaw/pull/12',
  createdAt: '2026-01-15T00:00:00Z', // after the run finished
};
const PR_LONG_STALE: GithubPullRequest = {
  number: 1,
  title: 'Ancient PR nobody would ever cite',
  url: 'https://github.com/openclaw/openclaw/pull/1',
  createdAt: '2020-01-01T00:00:00Z',
};

const ORACLE: OpenClawPrOracle = {
  recentPrs: [PR_CREATED_AFTER_RUN, PR_CREATED_MID_RUN, PR_MOST_RECENT_AT_START, PR_LONG_STALE],
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'openclaw-pr-grader-test-'));
  // Bypass initManifest (which stamps "now") so tests control the run
  // window precisely; writeArtifact only ever touches the artifacts array,
  // so startedAt/finishedAt survive every later write untouched.
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        task: 'openclaw_pr grader test',
        startedAt: RUN_STARTED_AT,
        finishedAt: RUN_FINISHED_AT,
        artifacts: [],
      },
      null,
      2,
    ),
  );
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function byName(results: { name: string; passed: boolean; detail: string }[], name: string) {
  const found = results.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no assertion named "${name}"`);
  return found;
}

function mentionText(pr: GithubPullRequest): string {
  return `The most recent PR is #${pr.number}, "${pr.title}".\n`;
}

describe('openclaw_pr grader', () => {
  it('passes every assertion when answer.md names the PR created during the run', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(mentionText(PR_CREATED_MID_RUN)), {
      roles: ['requested_output'],
    });

    const results = await grade(runDir, ORACLE);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('churn tolerance: accepts the PR that was most recent at run start too', async () => {
    writeArtifact(
      runDir,
      'artifacts/answer.md',
      Buffer.from(mentionText(PR_MOST_RECENT_AT_START)),
      { roles: ['requested_output'] },
    );

    const results = await grade(runDir, ORACLE);

    expect(
      byName(results, 'answer.md mentions the number and title of a most-recent-in-window PR')
        .passed,
    ).toBe(true);
  });

  it('churn tolerance: rejects a PR that only became most recent after the run finished', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(mentionText(PR_CREATED_AFTER_RUN)), {
      roles: ['requested_output'],
    });

    const results = await grade(runDir, ORACLE);

    expect(
      byName(results, 'answer.md mentions the number and title of a most-recent-in-window PR')
        .passed,
    ).toBe(false);
    expect(byName(results, 'answer.md exists').passed).toBe(true);
  });

  it('fails when answer.md names a PR that was never most-recent', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(mentionText(PR_LONG_STALE)), {
      roles: ['requested_output'],
    });

    const results = await grade(runDir, ORACLE);

    expect(
      byName(results, 'answer.md mentions the number and title of a most-recent-in-window PR')
        .passed,
    ).toBe(false);
  });

  it('fails both content assertions, with detail, when answer.md is missing', async () => {
    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'answer.md exists').passed).toBe(false);
    expect(
      byName(results, 'answer.md mentions the number and title of a most-recent-in-window PR')
        .passed,
    ).toBe(false);
    for (const r of results) {
      if (r.name === 'manifest hashes verify') continue;
      expect(r.detail).not.toBe('');
    }
  });

  it('fails only the manifest-hash assertion when answer.md is tampered with after capture', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(mentionText(PR_CREATED_MID_RUN)), {
      roles: ['requested_output'],
    });
    // Tamper behind the manifest's back: append text after capture. The
    // original correct mention is still present, so the content assertion
    // still passes; only the standing re-hash-from-disk assertion catches it.
    const tamperedPath = join(runDir, 'artifacts/answer.md');
    writeFileSync(tamperedPath, mentionText(PR_CREATED_MID_RUN) + '\n[appended after capture]\n');

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'manifest hashes verify').passed).toBe(false);
    expect(byName(results, 'answer.md exists').passed).toBe(true);
    expect(
      byName(results, 'answer.md mentions the number and title of a most-recent-in-window PR')
        .passed,
    ).toBe(true);
  });

  it('throws on malformed oracle data — a harness bug, not a failed trial', async () => {
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
