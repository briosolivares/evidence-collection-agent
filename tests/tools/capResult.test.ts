import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, MANIFEST_FILENAME, type Manifest } from '../../src/run/artifacts.js';
import {
  capResult,
  DEFAULT_MAX_RESULT_BYTES,
  OFFLOAD_DIR,
  PREVIEW_MAX_BYTES,
  type OffloadedResult,
} from '../../src/tools/capResult.js';

// A temp dir with an initialized manifest stands in for the run directory;
// the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'cap-result-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function readManifestFile(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

/** Narrow a capResult return to the offloaded shape, failing the test if it
 * passed through instead. */
function expectOffloaded(result: string | OffloadedResult): OffloadedResult {
  expect(typeof result).not.toBe('string');
  return result as OffloadedResult;
}

describe('capResult', () => {
  it('passes an under-cap result through byte-identical, touching nothing on disk', () => {
    const original = 'a modest tool result';
    const result = capResult(runDir, 'echo', original, 100);

    expect(result).toBe(original);
    expect(existsSync(join(runDir, OFFLOAD_DIR))).toBe(false);
  });

  it('passes a result of exactly maxBytes through unchanged (the boundary)', () => {
    const original = 'x'.repeat(64);
    const result = capResult(runDir, 'echo', original, 64);

    expect(result).toBe(original);
    expect(existsSync(join(runDir, OFFLOAD_DIR))).toBe(false);
  });

  it('offloads a result one byte over the cap, naming the file it wrote', () => {
    const original = 'x'.repeat(65);
    const result = expectOffloaded(capResult(runDir, 'echo', original, 64));

    expect(result.offloadedTo).toBe(`${OFFLOAD_DIR}/echo-1.txt`);
    // The note must point the model at the file so it can recover the rest.
    expect(result.note).toContain(result.offloadedTo);
    expect(readFileSync(join(runDir, result.offloadedTo), 'utf8')).toBe(original);
  });

  it('offloads the complete original output inside the run dir, hashed into the manifest', () => {
    // Over the default cap, so this exercises the real production path.
    const original = 'line of tool output\n'.repeat(6000); // 120 KB
    const result = expectOffloaded(
      capResult(runDir, 'inspect_page', original, DEFAULT_MAX_RESULT_BYTES),
    );

    const onDisk = readFileSync(join(runDir, result.offloadedTo), 'utf8');
    expect(onDisk).toBe(original);

    const manifest = readManifestFile();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      filename: result.offloadedTo,
      sha256: createHash('sha256').update(Buffer.from(original, 'utf8')).digest('hex'),
    });

    // The preview stays small even though the output is huge.
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(original.startsWith(result.preview)).toBe(true);
  });

  it('never splits a multi-byte UTF-8 character straddling the preview boundary', () => {
    // 'a' (1 byte) + a run of 4-byte emoji: with an 8-byte window the cut
    // falls mid-emoji (1 + 4 + 4 = 9 > 8), so the straddling character must
    // be dropped whole, not sliced into garbage.
    const original = `a${'😀'.repeat(50)}`;
    const result = expectOffloaded(capResult(runDir, 'echo', original, 8));

    expect(result.preview).toBe('a😀');
    expect(result.preview).not.toContain('�');
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(8);
    expect(original.startsWith(result.preview)).toBe(true);
  });

  it('cuts the preview at a line boundary when a newline falls late in the window', () => {
    // 8-byte lines; a 100-byte window holds 12 whole lines (96 bytes) plus a
    // fragment of the 13th — the preview must end on the 12th line, whole.
    const lines = Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`);
    const original = `${lines.join('\n')}\n`;
    const result = expectOffloaded(capResult(runDir, 'grep', original, 100));

    expect(result.preview.endsWith('line-12')).toBe(true);
    const previewLines = result.preview.split('\n');
    expect(previewLines.every((line) => /^line-\d\d$/.test(line))).toBe(true);
  });

  it('numbers successive offloads for the same tool so no file is ever clobbered', () => {
    const first = expectOffloaded(capResult(runDir, 'echo', 'first '.repeat(20), 16));
    const second = expectOffloaded(capResult(runDir, 'echo', 'second '.repeat(20), 16));

    expect(first.offloadedTo).toBe(`${OFFLOAD_DIR}/echo-1.txt`);
    expect(second.offloadedTo).toBe(`${OFFLOAD_DIR}/echo-2.txt`);
    expect(readFileSync(join(runDir, first.offloadedTo), 'utf8')).toBe('first '.repeat(20));
    expect(readFileSync(join(runDir, second.offloadedTo), 'utf8')).toBe('second '.repeat(20));
    expect(readManifestFile().artifacts).toHaveLength(2);
  });
});
