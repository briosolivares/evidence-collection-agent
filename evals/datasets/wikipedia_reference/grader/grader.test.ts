import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { WikipediaReferenceOracle } from '../oracle/wikipediaClient.js';
import { grade } from './grader.js';

const ORACLE: WikipediaReferenceOracle = {
  pageTitle: 'World War II', referenceNumber: 275, referenceId: 'cite_note-278',
  referenceText: 'Beevor 2012, pp. 555–560.', sourceId: 'CITEREFBeevor2012',
  sourceText: 'Beevor, Antony (2012). The Second World War. London: Weidenfeld & Nicolson. ISBN 978-0-297-84497-6.',
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'wikipedia-reference-grader-'));
  initManifest(runDir, 'wikipedia reference grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`missing assertion ${name}`);
  return found;
}

describe('wikipedia_reference grader', () => {
  it('passes the full source with harmless Markdown formatting', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(`# Source\n\n**Beevor, Antony (2012).** *The Second World War.* London: Weidenfeld & Nicolson. ISBN 978-0-297-84497-6.\n`), { roles: ['requested_output'] });
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects the short reference text in place of the linked Sources entry', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from('Beevor 2012, pp. 555–560.'), { roles: ['requested_output'] });
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'answer contains the complete source text reached from reference 275').passed).toBe(false);
  });

  it('rejects explicit truncation even if the source text is present', async () => {
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(`${ORACLE.sourceText} ...`), { roles: ['requested_output'] });
    expect(byName(await grade(runDir, ORACLE), 'answer has no truncation marker and is long enough for the full source').passed).toBe(false);
  });

  it('requires manifested answer.md, catches tampering, and rejects malformed oracle data', async () => {
    expect(byName(await grade(runDir, ORACLE), 'answer.md exists with a manifest entry').passed).toBe(false);
    writeArtifact(runDir, 'artifacts/answer.md', Buffer.from(ORACLE.sourceText), { roles: ['requested_output'] });
    writeFileSync(join(runDir, 'artifacts/answer.md'), `${ORACLE.sourceText} changed`);
    expect(byName(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
    await expect(async () => grade(runDir, { sourceText: 'wrong' })).rejects.toThrow(/oracle/);
  });
});
