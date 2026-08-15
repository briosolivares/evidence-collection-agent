import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolUseBlock } from '../../loop/messages.js';
import {
  MANIFEST_FILENAME,
  initManifest,
  writeArtifact,
} from '../../run/artifacts.js';
import {
  createV3VerifierRegistry,
  executeV3VerifierToolUses,
} from './verifierTools.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-verifier-tools-'));
  initManifest(runDir, 'Inspect the published report.');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function use(name: string, input: unknown, id = 'call-1'): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

describe('v3 verifier inspection', () => {
  it('bounds oversized reads in memory without mutating manifest or scratch', async () => {
    writeArtifact(
      runDir,
      'artifacts/large.txt',
      Buffer.from(`needle ${'x'.repeat(80_000)}\n`, 'utf8'),
      { roles: ['requested_output'] },
    );
    const before = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');

    const [result] = await executeV3VerifierToolUses(
      createV3VerifierRegistry(),
      [use('read_file', { file_path: 'artifacts/large.txt' })],
      { runDir },
    );

    expect(result?.is_error).not.toBe(true);
    expect(JSON.stringify(result?.content)).toContain('truncated in memory');
    expect(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')).toBe(before);
    expect(existsSync(join(runDir, 'scratch/tool-output'))).toBe(false);
  });

  it('rejects scratch evidence even when the worker manifested it', async () => {
    writeArtifact(
      runDir,
      'scratch/evidence/self-authored.txt',
      Buffer.from('unsupported worker claim\n'),
    );

    const [result] = await executeV3VerifierToolUses(
      createV3VerifierRegistry(),
      [use('read_file', { file_path: 'scratch/evidence/self-authored.txt' })],
      { runDir },
    );

    expect(result).toMatchObject({ is_error: true });
    expect(JSON.stringify(result?.content)).toMatch(/outside v3 verifier scope/i);
  });

  it('uses bounded literal grep instead of evaluating model-supplied regex', async () => {
    writeArtifact(
      runDir,
      'artifacts/report.txt',
      Buffer.from('ordinary aaaaaaaaaaaaaaaaaaaa line\nliteral (a+)+$ marker\n'),
      { roles: ['requested_output'] },
    );

    const [result] = await executeV3VerifierToolUses(
      createV3VerifierRegistry(),
      [use('grep', { pattern: '(a+)+$', path: 'artifacts' })],
      { runDir },
    );

    expect(result?.is_error).not.toBe(true);
    expect(result?.content).toContain('literal (a+)+$ marker');
    expect(result?.content).not.toContain('ordinary aaaaa');
  });

  it('checks cancellation before inspection work', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeV3VerifierToolUses(
        createV3VerifierRegistry(),
        [use('grep', { pattern: 'anything' })],
        { runDir, abortSignal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns a valid published PNG as an image block', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    writeArtifact(runDir, 'artifacts/evidence.png', png, {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    });

    const [result] = await executeV3VerifierToolUses(
      createV3VerifierRegistry(),
      [use('read_file', { file_path: 'artifacts/evidence.png' })],
      { runDir },
    );

    expect(result?.is_error).not.toBe(true);
    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
      ]),
    );
  });
});
