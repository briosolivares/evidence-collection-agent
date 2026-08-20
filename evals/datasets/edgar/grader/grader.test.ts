import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import { sha256Hex } from '../../../grading/hash.js';
import type { EdgarOracle } from '../oracle/edgarClient.js';
import { grade } from './grader.js';
import { byName } from '../../../testSupport.js';

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOCUMENT_BYTES = Buffer.from('<html>the 8-K filing body</html>');

const ORACLE: EdgarOracle = {
  filing: {
    accessionNumber: '0000320193-26-000008',
    form: '8-K',
    filingDate: '2026-01-29',
    primaryDocument: 'aapl-8k-0129.htm',
  },
  documentUrl: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000008/aapl-8k-0129.htm',
  documentBytes: DOCUMENT_BYTES,
  documentSha256: sha256Hex(DOCUMENT_BYTES),
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'edgar-grader-test-'));
  initManifest(runDir, 'edgar grader test');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('edgar grader', () => {
  it('passes every assertion when the download matches and a real screenshot exists', async () => {
    writeArtifact(runDir, 'artifacts/aapl-8k-0129.htm', DOCUMENT_BYTES, {
      sourceUrl: ORACLE.documentUrl,
      roles: ['requested_output', 'evidence'],
    });
    writeArtifact(
      runDir,
      'artifacts/filing-page.png',
      Buffer.concat([PNG_MAGIC_BYTES, Buffer.from('fakepixels')]),
      {
        roles: ['requested_output', 'evidence'],
      },
    );

    const results = await grade(runDir, ORACLE);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails only the document-hash assertion when no downloaded artifact matches', async () => {
    // Published as a requested output, so the hash check — not the role
    // filter — is what rejects it.
    writeArtifact(runDir, 'artifacts/wrong-doc.htm', Buffer.from('not the filing'), {
      roles: ['requested_output', 'evidence'],
    });
    writeArtifact(
      runDir,
      'artifacts/filing-page.png',
      Buffer.concat([PNG_MAGIC_BYTES, Buffer.from('fakepixels')]),
      {
        roles: ['requested_output', 'evidence'],
      },
    );

    const results = await grade(runDir, ORACLE);

    expect(
      byName(results, "downloaded document hash-matches the accession's document").passed,
    ).toBe(false);
    expect(byName(results, 'screenshot artifact exists with a manifest entry').passed).toBe(true);
  });

  it('fails only the screenshot assertion when no screenshot artifact exists', async () => {
    writeArtifact(runDir, 'artifacts/aapl-8k-0129.htm', DOCUMENT_BYTES, {
      sourceUrl: ORACLE.documentUrl,
      roles: ['requested_output', 'evidence'],
    });

    const results = await grade(runDir, ORACLE);

    expect(
      byName(results, "downloaded document hash-matches the accession's document").passed,
    ).toBe(true);
    expect(byName(results, 'screenshot artifact exists with a manifest entry').passed).toBe(false);
  });

  it('fails the screenshot assertion for a .png file that is not actually a PNG', async () => {
    writeArtifact(runDir, 'artifacts/aapl-8k-0129.htm', DOCUMENT_BYTES, {
      sourceUrl: ORACLE.documentUrl,
      roles: ['requested_output', 'evidence'],
    });
    // Published as a requested output, so the PNG-bytes check — not the
    // role filter — is what rejects it.
    writeArtifact(runDir, 'artifacts/filing-page.png', Buffer.from('not really a png'), {
      roles: ['requested_output', 'evidence'],
    });

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'screenshot artifact exists with a manifest entry').passed).toBe(false);
  });

  it('fails only the manifest-hash assertion when the download is tampered with after capture', async () => {
    writeArtifact(runDir, 'artifacts/aapl-8k-0129.htm', DOCUMENT_BYTES, {
      sourceUrl: ORACLE.documentUrl,
      roles: ['requested_output', 'evidence'],
    });
    writeArtifact(
      runDir,
      'artifacts/filing-page.png',
      Buffer.concat([PNG_MAGIC_BYTES, Buffer.from('fakepixels')]),
      {
        roles: ['requested_output', 'evidence'],
      },
    );
    // Tamper behind the manifest's back: the manifest still records the
    // correct (matching) hash, so the document-match assertion — which
    // trusts the manifest's recorded hash — still passes; only the standing
    // re-hash-from-disk assertion catches the tamper.
    writeFileSync(join(runDir, 'artifacts/aapl-8k-0129.htm'), 'doctored filing content');

    const results = await grade(runDir, ORACLE);

    expect(byName(results, 'manifest hashes verify').passed).toBe(false);
    expect(
      byName(results, "downloaded document hash-matches the accession's document").passed,
    ).toBe(true);

    // Malformed oracle data is a harness bug, not a failed trial.
    await expect(async () => grade(runDir, { wrong: 'shape' })).rejects.toThrow(/oracle/);
  });
});
