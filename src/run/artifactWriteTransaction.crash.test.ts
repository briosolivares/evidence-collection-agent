import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_WRITE_JOURNAL_PATH,
  initManifest,
  readManifest,
  recoverPendingArtifactWrites,
  writeArtifact,
  type ArtifactMeta,
  type ManifestEntry,
} from './artifacts.js';
import {
  ARTIFACT_WRITE_MAX_JOURNAL_BYTES,
  ARTIFACT_WRITE_MAX_MANIFEST_BYTES,
  commitArtifactWriteTransaction,
} from './artifactWriteTransaction.js';

type Boundary = 'after_journal' | 'after_temp' | 'after_artifact';

interface RunningChild {
  child: ChildProcess;
  stderr: string;
  stdout: string;
}

const CHILD_FIXTURE = fileURLToPath(
  new URL('../../tests/fixtures/artifactWriteCrashChild.ts', import.meta.url),
);
const PROCESS_TIMEOUT_MS = 15_000;
const processDescribe = process.platform === 'win32' ? describe.skip : describe;

let tempRoot: string;
let runDir: string;
const activeChildren = new Set<RunningChild>();

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'artifact-transaction-crash-'));
  runDir = join(tempRoot, 'run');
  // Non-recursive creation makes accidental reuse visible, just like a real run.
  mkdirSync(runDir);
  initManifest(runDir, 'crash-consistent artifact test');
});

afterEach(async () => {
  await Promise.all([...activeChildren].map(stopChild));
  rmSync(tempRoot, { recursive: true, force: true });
});

processDescribe('artifact write transaction real-process crash recovery', () => {
  it('recovers a new published binary killed after bytes but before the manifest', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const beforeManifest = manifestBytes();

    await runAndExpectSigkill(
      'after_artifact',
      'artifacts/capture.bin',
      bytes,
      {
        roles: ['requested_output', 'evidence'],
        sourceUrl: 'https://example.test/capture',
      },
    );

    expect(readFileSync(join(runDir, 'artifacts/capture.bin'))).toEqual(bytes);
    expect(manifestBytes()).toEqual(beforeManifest);
    expect(journalFiles()).toHaveLength(1);
    const intent = JSON.parse(
      readFileSync(
        join(runDir, ARTIFACT_WRITE_JOURNAL_PATH, journalFiles()[0]!),
        'utf8',
      ),
    ) as Record<string, Record<string, unknown>>;
    expect(intent).toMatchObject({
      version: 1,
      owner: {
        processId: expect.any(Number),
        transactionId: expect.any(String),
      },
      target: {
        filename: 'artifacts/capture.bin',
        byteLength: bytes.byteLength,
        sha256: hash(bytes),
      },
      entry: {
        filename: 'artifacts/capture.bin',
        roles: ['requested_output', 'evidence'],
        sourceUrl: 'https://example.test/capture',
        sha256: hash(bytes),
      },
    });
    expect(
      statSync(join(runDir, ARTIFACT_WRITE_JOURNAL_PATH, journalFiles()[0]!)).mode &
        0o777,
    ).toBe(0o600);

    const recovered = recoverPendingArtifactWrites(runDir);
    expect(recovered).toMatchObject({ recoveredEntries: 1, discardedIntents: 0 });
    expect(readManifest(runDir).artifacts).toEqual([
      expect.objectContaining({
        filename: 'artifacts/capture.bin',
        roles: ['requested_output', 'evidence'],
        sourceUrl: 'https://example.test/capture',
        sha256: hash(bytes),
      }),
    ]);
    expect(journalFiles()).toEqual([]);
    expect(recoverPendingArtifactWrites(runDir)).toEqual({
      recoveredEntries: 0,
      discardedIntents: 0,
      removedArtifactTemps: 0,
      removedJournalTemps: 0,
    });
  });

  it('recovers an overwritten private scratch file without inventing roles', async () => {
    const oldBytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const newBytes = Buffer.from([0xff, 0x00, 0x81, 0x11, 0x42]);
    const oldEntry = writeArtifact(runDir, 'scratch/private.bin', oldBytes);

    await runAndExpectSigkill('after_artifact', 'scratch/private.bin', newBytes, {});

    expect(readFileSync(join(runDir, 'scratch/private.bin'))).toEqual(newBytes);
    expect(readManifest(runDir).artifacts).toEqual([oldEntry]);

    expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
      recoveredEntries: 1,
      discardedIntents: 0,
    });
    const [recovered] = readManifest(runDir).artifacts;
    expect(recovered).toMatchObject({
      filename: 'scratch/private.bin',
      sha256: hash(newBytes),
    });
    expect(recovered).not.toHaveProperty('roles');
  });

  it('preserves an old file and manifest when killed after the intent but before the file', async () => {
    const oldBytes = Buffer.from('old complete bytes');
    const newBytes = Buffer.from('new intended bytes');
    writeArtifact(runDir, 'artifacts/report.txt', oldBytes, {
      roles: ['requested_output'],
    });
    const beforeManifest = manifestBytes();

    await runAndExpectSigkill(
      'after_journal',
      'artifacts/report.txt',
      newBytes,
      { roles: ['requested_output'] },
    );

    expect(readFileSync(join(runDir, 'artifacts/report.txt'))).toEqual(oldBytes);
    expect(manifestBytes()).toEqual(beforeManifest);
    expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
      recoveredEntries: 0,
      discardedIntents: 1,
    });
    expect(readFileSync(join(runDir, 'artifacts/report.txt'))).toEqual(oldBytes);
    expect(manifestBytes()).toEqual(beforeManifest);
    expect(journalFiles()).toEqual([]);
  });

  it(
    'never exposes torn bytes when killed after the staged file fsync',
    async () => {
      const oldBytes = Buffer.alloc(512 * 1024, 0x35);
      const newBytes = Buffer.alloc(768 * 1024, 0xca);
      writeArtifact(runDir, 'artifacts/large.bin', oldBytes, {
        roles: ['requested_output'],
      });
      const beforeManifest = manifestBytes();

      await runAndExpectSigkill(
        'after_temp',
        'artifacts/large.bin',
        newBytes,
        { roles: ['requested_output'] },
      );

      // The destination is still the complete old inode. The complete new
      // inode is private staging state and is never visible at the target path.
      expect(readFileSync(join(runDir, 'artifacts/large.bin'))).toEqual(oldBytes);
      expect(manifestBytes()).toEqual(beforeManifest);
      expect(artifactTempFiles('artifacts')).toHaveLength(1);

      expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
        recoveredEntries: 0,
        discardedIntents: 1,
        removedArtifactTemps: 1,
      });
      expect(readFileSync(join(runDir, 'artifacts/large.bin'))).toEqual(oldBytes);
      expect(manifestBytes()).toEqual(beforeManifest);
      expect(artifactTempFiles('artifacts')).toEqual([]);
    },
    20_000,
  );

  it('recovers multiple distinct pending journals without losing either entry', async () => {
    const first = startCrashChild(
      'after_artifact',
      'artifacts/one.bin',
      Buffer.from([1, 2, 3]),
      { roles: ['requested_output'] },
    );
    const second = startCrashChild(
      'after_artifact',
      'scratch/two.bin',
      Buffer.from([4, 5, 6]),
      {},
    );
    await Promise.all([expectSigkill(first), expectSigkill(second)]);
    expect(journalFiles()).toHaveLength(2);

    expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
      recoveredEntries: 2,
      discardedIntents: 0,
    });
    expect(readManifest(runDir).artifacts.map((entry) => entry.filename).sort()).toEqual([
      'artifacts/one.bin',
      'scratch/two.bin',
    ]);
  });

  it('does not follow a target symlink even when its referent has the intended bytes', async () => {
    const bytes = Buffer.from('matching bytes outside the run');
    const outsidePath = join(tempRoot, 'outside.bin');
    writeFileSync(outsidePath, bytes);
    await runAndExpectSigkill(
      'after_artifact',
      'artifacts/link.bin',
      bytes,
      { roles: ['requested_output'] },
    );
    unlinkSync(join(runDir, 'artifacts/link.bin'));
    symlinkSync(outsidePath, join(runDir, 'artifacts/link.bin'));

    expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
      recoveredEntries: 0,
      discardedIntents: 1,
    });
    expect(readManifest(runDir).artifacts).toEqual([]);
    expect(readFileSync(outsidePath)).toEqual(bytes);
  });
});

describe('artifact write transaction bounded recovery', () => {
  it('rejects an oversized manifest before parsing it', () => {
    writeFileSync(
      join(runDir, 'manifest.json'),
      Buffer.alloc(ARTIFACT_WRITE_MAX_MANIFEST_BYTES + 1, 0x20),
    );

    expect(() => recoverPendingArtifactWrites(runDir)).toThrow(
      new RegExp(
        `${ARTIFACT_WRITE_MAX_MANIFEST_BYTES}-byte artifact transaction recovery limit`,
      ),
    );
  });

  it('rejects an oversized private journal before parsing it', () => {
    writeArtifact(runDir, 'scratch/seed.txt', Buffer.from('seed'));
    const journalPath = join(
      runDir,
      ARTIFACT_WRITE_JOURNAL_PATH,
      'oversized.json',
    );
    writeFileSync(
      journalPath,
      Buffer.alloc(ARTIFACT_WRITE_MAX_JOURNAL_BYTES + 1, 0x20),
      { mode: 0o600 },
    );

    expect(() => recoverPendingArtifactWrites(runDir)).toThrow(
      new RegExp(
        `${ARTIFACT_WRITE_MAX_JOURNAL_BYTES}-byte artifact transaction recovery limit`,
      ),
    );
    expect(existsSync(journalPath)).toBe(true);
  });

  it('propagates the trusted guard while enumerating private recovery state', () => {
    writeArtifact(runDir, 'scratch/seed.txt', Buffer.from('seed'));
    const orphanName =
      '.5ed45d5e-f5c4-4d43-bfd1-12c7f2ac4d77.json.123.' +
      '32e43365-945b-4a20-b537-013f6bb87a9e.tmp';
    const orphanPath = join(runDir, ARTIFACT_WRITE_JOURNAL_PATH, orphanName);
    writeFileSync(orphanPath, 'unpublished journal staging bytes');
    const interrupted = new Error('recovery deadline reached during enumeration');
    let checks = 0;
    let thrown: unknown;

    try {
      recoverPendingArtifactWrites(runDir, {
        checkActive: () => {
          checks += 1;
          // Start + the bounded manifest read consume the first three checks.
          if (checks === 4) throw interrupted;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(4);
    expect(existsSync(orphanPath)).toBe(true);
  });

  it('propagates the trusted guard between target hash chunks without publishing', () => {
    const bytes = Buffer.alloc(4 * 64 * 1024, 0x5a);
    leavePendingArtifact('artifacts/guarded.bin', bytes);
    const interrupted = new Error('recovery deadline reached during target hash');
    let checks = 0;
    let thrown: unknown;

    try {
      recoverPendingArtifactWrites(runDir, {
        checkActive: () => {
          checks += 1;
          // Eight checks precede target streaming; this interrupts its third chunk.
          if (checks === 11) throw interrupted;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(interrupted);
    expect(checks).toBe(11);
    expect(readManifest(runDir).artifacts).toEqual([]);
    expect(readFileSync(join(runDir, 'artifacts/guarded.bin'))).toEqual(bytes);
    expect(journalFiles()).toHaveLength(1);
  });
});

describe('artifact write transaction ordinary failure cleanup', () => {
  it('removes its journal and staging state when an exception occurs before publication', () => {
    const bytes = Buffer.from('will not publish');
    const entry: ManifestEntry = {
      filename: 'artifacts/failure.txt',
      sha256: hash(bytes),
      roles: ['requested_output'],
      capturedAt: new Date().toISOString(),
    };

    expect(() =>
      commitArtifactWriteTransaction(runDir, entry, bytes, {
        afterJournalPersisted: () => {
          throw new Error('ordinary injected failure');
        },
      }),
    ).toThrow(/ordinary injected failure/);

    expect(existsSync(join(runDir, entry.filename))).toBe(false);
    expect(readManifest(runDir).artifacts).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(artifactTempFiles('artifacts')).toEqual([]);
  });

  it('keeps harness state owner-only', () => {
    const bytes = Buffer.from('private modes');
    writeArtifact(runDir, 'scratch/modes.txt', bytes);

    const harnessDir = join(runDir, 'harness');
    const journalDir = join(runDir, ARTIFACT_WRITE_JOURNAL_PATH);
    expect(statSync(harnessDir).mode & 0o777).toBe(0o700);
    expect(statSync(journalDir).mode & 0o777).toBe(0o700);
  });

  it('removes only recognized orphan journal staging files', () => {
    writeArtifact(runDir, 'scratch/seed.txt', Buffer.from('seed'));
    const journalDir = join(runDir, ARTIFACT_WRITE_JOURNAL_PATH);
    const orphanName =
      '.5ed45d5e-f5c4-4d43-bfd1-12c7f2ac4d77.json.123.' +
      '32e43365-945b-4a20-b537-013f6bb87a9e.tmp';
    writeFileSync(join(journalDir, orphanName), 'complete but unpublished journal bytes');
    writeFileSync(join(journalDir, 'leave-me.tmp'), 'not owned by this protocol');

    expect(recoverPendingArtifactWrites(runDir)).toMatchObject({
      removedJournalTemps: 1,
    });
    expect(existsSync(join(journalDir, orphanName))).toBe(false);
    expect(existsSync(join(journalDir, 'leave-me.tmp'))).toBe(true);
  });
});

async function runAndExpectSigkill(
  boundary: Boundary,
  filename: string,
  bytes: Buffer,
  meta: ArtifactMeta,
): Promise<void> {
  await expectSigkill(startCrashChild(boundary, filename, bytes, meta));
}

function startCrashChild(
  boundary: Boundary,
  filename: string,
  bytes: Buffer,
  meta: ArtifactMeta,
): RunningChild {
  const payloadPath = join(tempRoot, `payload-${Math.random().toString(16).slice(2)}.bin`);
  writeFileSync(payloadPath, bytes);
  const child = fork(
    CHILD_FIXTURE,
    [boundary, runDir, filename, payloadPath, JSON.stringify(meta)],
    {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      silent: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  );
  const running: RunningChild = { child, stderr: '', stdout: '' };
  child.stderr?.on('data', (chunk: Buffer | string) => {
    running.stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    running.stdout += chunk.toString();
  });
  activeChildren.add(running);
  return running;
}

async function expectSigkill(running: RunningChild): Promise<void> {
  const exit = await waitForExit(running);
  activeChildren.delete(running);
  expect(exit.signal, diagnostic(running)).toBe('SIGKILL');
  expect(exit.code, diagnostic(running)).toBeNull();
}

async function stopChild(running: RunningChild): Promise<void> {
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGKILL');
  }
  try {
    await waitForExit(running, 3_000);
  } catch {
    // Best effort during afterEach; explicit test failures retain diagnostics.
  }
  activeChildren.delete(running);
}

function waitForExit(
  running: RunningChild,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return Promise.resolve({
      code: running.child.exitCode,
      signal: running.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for artifact crash fixture${diagnostic(running)}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off('exit', onExit);
    };
    running.child.once('exit', onExit);
  });
}

function journalFiles(): string[] {
  const path = join(runDir, ARTIFACT_WRITE_JOURNAL_PATH);
  return existsSync(path)
    ? readdirSync(path).filter((name) => name.endsWith('.json'))
    : [];
}

function artifactTempFiles(workspace: 'artifacts' | 'scratch'): string[] {
  return readdirSync(join(runDir, workspace)).filter(
    (name) => name.startsWith('.') && name.endsWith('.tmp'),
  );
}

function manifestBytes(): Buffer {
  return readFileSync(join(runDir, 'manifest.json'));
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function leavePendingArtifact(filename: string, bytes: Buffer): void {
  const interrupted = new Error('injected failure after artifact publication');
  const entry: ManifestEntry = {
    filename,
    sha256: hash(bytes),
    roles: ['requested_output'],
    capturedAt: new Date().toISOString(),
  };
  let thrown: unknown;
  try {
    commitArtifactWriteTransaction(runDir, entry, bytes, {
      afterArtifactCommitted: () => {
        throw interrupted;
      },
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(interrupted);
}

function diagnostic(running: RunningChild): string {
  const output = [running.stderr.trim(), running.stdout.trim()]
    .filter((value) => value !== '')
    .join('\n');
  return output === '' ? '' : `\nfixture output:\n${output}`;
}
