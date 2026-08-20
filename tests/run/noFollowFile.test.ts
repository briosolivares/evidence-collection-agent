import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  inspectPathNoFollow,
  NoFollowFileError,
  readFileChunksNoFollow,
  readFileNoFollow,
} from '../../src/run/noFollowFile.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'no-follow-file-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('no-follow regular-file helpers', () => {
  it('reads exact bytes through both chunk and Buffer interfaces', () => {
    const path = join(directory, 'data.bin');
    writeFileSync(path, Buffer.from([0, 1, 2, 3, 255]));

    expect([...readFileChunksNoFollow(path, { chunkBytes: 2 })].map((chunk) => [...chunk])).toEqual(
      [[0, 1], [2, 3], [255]],
    );
    expect(readFileNoFollow(path)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it('rejects final-component symlinks instead of following them', () => {
    const target = join(directory, 'target.txt');
    const link = join(directory, 'link.txt');
    writeFileSync(target, 'secret');
    symlinkSync(target, link);

    expect(() => readFileNoFollow(link)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }) as Error,
    );
  });

  it('rejects non-regular descriptors', () => {
    const path = join(directory, 'subdirectory');
    mkdirSync(path);

    expect(() => inspectPathNoFollow(path)).toThrow(
      expect.objectContaining({ kind: 'not_regular' }) as NoFollowFileError,
    );
  });

  it('distinguishes an initial size violation from growth during reading', () => {
    const initiallyLarge = join(directory, 'large.txt');
    writeFileSync(initiallyLarge, '12345');
    expect(() => readFileNoFollow(initiallyLarge, { maxBytes: 4 })).toThrow(
      expect.objectContaining({
        kind: 'max_bytes',
        phase: 'inspection',
        observedBytes: 5,
      }) as Error,
    );

    const growing = join(directory, 'growing.txt');
    writeFileSync(growing, '1234');
    const chunks = readFileChunksNoFollow(growing, { maxBytes: 4, chunkBytes: 2 });
    expect(chunks.next().value).toEqual(Buffer.from('12'));
    appendFileSync(growing, '56');
    expect(() => [...chunks]).toThrow(
      expect.objectContaining({ kind: 'max_bytes', phase: 'read', observedBytes: 6 }) as Error,
    );
  });

  it('optionally enforces descriptor mode and stable size', () => {
    const path = join(directory, 'stable.txt');
    writeFileSync(path, '1234');
    chmodSync(path, 0o600);
    expect(inspectPathNoFollow(path, { expectedMode: 0o600 }).size).toBe(4);
    expect(() => inspectPathNoFollow(path, { expectedMode: 0o644 })).toThrow(
      expect.objectContaining({ kind: 'mode_mismatch' }) as NoFollowFileError,
    );

    const chunks = readFileChunksNoFollow(path, { chunkBytes: 2, stableSize: true });
    expect(chunks.next().value).toEqual(Buffer.from('12'));
    appendFileSync(path, '5');
    expect(() => [...chunks]).toThrow(
      expect.objectContaining({ kind: 'changed' }) as NoFollowFileError,
    );
  });

  it('runs the active guard between chunks and propagates its exact failure', () => {
    const path = join(directory, 'guarded.txt');
    writeFileSync(path, '1234');
    const stopped = new Error('deadline');
    let checks = 0;

    expect(() =>
      readFileNoFollow(path, {
        chunkBytes: 1,
        checkActive: () => {
          checks += 1;
          if (checks === 3) throw stopped;
        },
      }),
    ).toThrow(stopped);
    expect(checks).toBe(3);
  });
});
