import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { CompanyFreshnessOracle } from '../oracle/companyContentClient.js';
import { grade } from './grader.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ORACLE: CompanyFreshnessOracle = {
  companies: [
    { name: 'Notion', homepageHosts: ['notion.com', 'www.notion.com'], contentCandidates: [{ url: 'https://www.notion.com/blog/new-notion', title: 'New Notion', publishedAt: '2026-08-10T00:00:00Z' }] },
    { name: 'Figma', homepageHosts: ['figma.com', 'www.figma.com'], contentCandidates: [{ url: 'https://www.figma.com/blog/new-figma/', title: 'New Figma', publishedAt: '2026-08-09T00:00:00Z' }] },
    { name: 'Eight Sleep', homepageHosts: ['eightsleep.com', 'www.eightsleep.com'], contentCandidates: [{ url: 'https://www.eightsleep.com/blog/new-eight', title: 'New Eight', publishedAt: '2026-08-08T00:00:00Z' }] },
  ],
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'company-freshness-grader-'));
  initManifest(runDir, 'company screenshots grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function writeScreenshots(): void {
  const pairs = [
    ['notion-home.png', 'https://www.notion.com/'], ['notion-content.png', 'https://www.notion.com/en-us/blog/new-notion'],
    ['figma-home.png', 'https://www.figma.com/'], ['figma-content.png', 'https://www.figma.com/blog/new-figma/'],
    ['eight-home.png', 'https://www.eightsleep.com/us/'], ['eight-content.png', 'https://www.eightsleep.com/blog/new-eight'],
  ];
  for (const [filename, sourceUrl] of pairs) writeArtifact(runDir, filename!, PNG, { sourceUrl });
}
function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`missing assertion ${name}`);
  return found;
}

describe('company_freshness grader', () => {
  it('passes six provenance-matched PNGs including localized paths', async () => {
    writeScreenshots();
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects an old official content page outside the live window', async () => {
    writeScreenshots();
    writeArtifact(runDir, 'notion-content.png', PNG, { sourceUrl: 'https://www.notion.com/blog/old-post' });
    expect(byName(await grade(runDir, ORACLE), 'each company has a valid screenshot from its live latest-content window').passed).toBe(false);
  });

  it('rejects invalid PNG bytes and lookalike domains', async () => {
    writeScreenshots();
    writeArtifact(runDir, 'figma-home.png', Buffer.from('not png'), { sourceUrl: 'https://figma.com.evil.example/' });
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'at least six valid manifested PNG screenshots exist').passed).toBe(false);
    expect(byName(results, 'each company has a valid screenshot of its official homepage').passed).toBe(false);
  });

  it('verifies hashes and rejects malformed oracle data', async () => {
    writeScreenshots();
    writeFileSync(join(runDir, 'figma-content.png'), Buffer.concat([PNG, Buffer.from('tampered')]));
    expect(byName(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
    await expect(async () => grade(runDir, { companies: [] })).rejects.toThrow(/oracle/);
  });
});
