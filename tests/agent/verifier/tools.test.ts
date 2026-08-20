import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolResultBlock, ToolUseBlock } from '../../../src/model/messages.js';
import { MANIFEST_FILENAME, initManifest, writeArtifact } from '../../../src/run/artifacts.js';
import {
  VERIFIER_MAX_IMAGE_BYTES,
  VERIFIER_MAX_IMAGE_DIMENSION_PX,
  createVerifierPathPolicy,
  createVerifierRegistry,
  executeVerifierToolUses,
} from '../../../src/agent/verifier/tools.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-verifier-tools-'));
  initManifest(runDir, 'Inspect the published report.');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function use(name: string, input: unknown, id = 'call-1'): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function inspect(
  toolUses: readonly ToolUseBlock[],
  allowedArtifactPaths: readonly string[],
  abortSignal?: AbortSignal,
) {
  const policy = createVerifierPathPolicy(allowedArtifactPaths);
  return executeVerifierToolUses(
    createVerifierRegistry(policy),
    toolUses,
    { runDir, ...(abortSignal === undefined ? {} : { abortSignal }) },
    policy,
  );
}

async function readPublishedImage(
  filename: string,
  bytes: Buffer,
): Promise<ToolResultBlock | undefined> {
  writeArtifact(runDir, `artifacts/${filename}`, bytes, {
    roles: ['evidence'],
  });
  const [result] = await inspect(
    [use('read_file', { file_path: `artifacts/${filename}` })],
    [`artifacts/${filename}`],
  );
  return result;
}

function jpegHeader(width: number, height: number): Buffer {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x11, 0x00,
  ]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

describe('verifier inspection', () => {
  it('bounds oversized reads in memory without mutating manifest or scratch', async () => {
    writeArtifact(
      runDir,
      'artifacts/large.txt',
      Buffer.from(`needle ${'x'.repeat(80_000)}\n`, 'utf8'),
      { roles: ['requested_output'] },
    );
    const before = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');

    const [result] = await inspect(
      [use('read_file', { file_path: 'artifacts/large.txt' })],
      ['artifacts/large.txt'],
    );

    expect(result?.is_error).not.toBe(true);
    expect(JSON.stringify(result?.content)).toContain('truncated in memory');
    expect(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')).toBe(before);
    expect(existsSync(join(runDir, 'scratch/tool-output'))).toBe(false);
  });

  it('rejects invalid UTF-8 with the verifier-specific binary inspection guidance', async () => {
    writeArtifact(runDir, 'artifacts/invalid.txt', Buffer.from([0x68, 0x69, 0xff]), {
      roles: ['requested_output'],
    });

    const [result] = await inspect(
      [use('read_file', { file_path: 'artifacts/invalid.txt' })],
      ['artifacts/invalid.txt'],
    );

    expect(result).toMatchObject({ is_error: true });
    expect(result?.content).toContain('not bounded UTF-8 text');
  });

  // All three funnel through the same allowedArtifactPaths check, but each names a
  // distinct leak category: scratch evidence, the raw manifest, and a published file
  // the surfaced role set omitted.
  it.each([
    {
      leak: 'scratch evidence even when the worker manifested it',
      write: () =>
        writeArtifact(
          runDir,
          'scratch/evidence/self-authored.txt',
          Buffer.from('unsupported worker claim\n'),
        ),
      path: 'scratch/evidence/self-authored.txt',
    },
    {
      leak: 'the raw manifest',
      write: () => undefined,
      path: MANIFEST_FILENAME,
    },
    {
      leak: 'a published file omitted from the surfaced role set',
      write: () =>
        writeArtifact(
          runDir,
          'artifacts/unpublished-to-judge.txt',
          Buffer.from('not in the judge payload\n'),
          { roles: ['evidence'] },
        ),
      path: 'artifacts/unpublished-to-judge.txt',
    },
  ])('rejects $leak as outside verifier scope', async ({ write, path }) => {
    write();

    const [result] = await inspect([use('read_file', { file_path: path })], []);

    expect(result).toMatchObject({ is_error: true });
    expect(JSON.stringify(result?.content)).toMatch(/outside verifier scope/i);
  });

  it('uses bounded literal grep instead of evaluating model-supplied regex', async () => {
    writeArtifact(
      runDir,
      'artifacts/report.txt',
      Buffer.from('ordinary aaaaaaaaaaaaaaaaaaaa line\nliteral (a+)+$ marker\n'),
      { roles: ['requested_output'] },
    );

    const [result] = await inspect(
      [use('grep', { pattern: '(a+)+$', path: 'artifacts' })],
      ['artifacts/report.txt'],
    );

    expect(result?.is_error).not.toBe(true);
    expect(result?.content).toContain('literal (a+)+$ marker');
    expect(result?.content).not.toContain('ordinary aaaaa');
  });

  it('checks cancellation before inspection work', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      inspect([use('grep', { pattern: 'anything' })], [], controller.signal),
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

    const [result] = await inspect(
      [use('read_file', { file_path: 'artifacts/evidence.png' })],
      ['artifacts/evidence.png'],
    );

    expect(result?.is_error).not.toBe(true);
    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
    );
  });

  it('rejects an image one byte above the encoded-request safety cap', async () => {
    const bytes = Buffer.alloc(VERIFIER_MAX_IMAGE_BYTES + 1);

    const result = await readPublishedImage('oversized.png', bytes);

    expect(result).toMatchObject({ is_error: true });
    expect(result?.content).toContain(`is ${VERIFIER_MAX_IMAGE_BYTES + 1} bytes`);
    expect(result?.content).toContain(`limit ${VERIFIER_MAX_IMAGE_BYTES}`);
  });

  it('rejects a JPEG whose header declares an over-limit dimension', async () => {
    const width = VERIFIER_MAX_IMAGE_DIMENSION_PX + 1;

    const result = await readPublishedImage('too-wide.jpg', jpegHeader(width, 1));

    expect(result).toMatchObject({ is_error: true });
    expect(result?.content).toContain(`${width}x1 pixels`);
    expect(result?.content).toContain(`limit ${VERIFIER_MAX_IMAGE_DIMENSION_PX} per dimension`);
  });

  it('rejects malformed image headers before creating an image block', async () => {
    const result = await readPublishedImage('malformed.png', Buffer.from('not a PNG', 'utf8'));

    expect(result).toMatchObject({
      content: expect.stringContaining('Not a readable image/png image'),
      is_error: true,
    });
  });
});
