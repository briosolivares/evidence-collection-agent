import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../../src/browser/controller.js';
import {
  initManifest,
  readManifest,
  writeArtifact,
  type ManifestEntry,
} from '../../../src/run/artifacts.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry, toApiToolDefs } from '../../../src/tools/registry.js';
import {
  MAX_PUBLISH_ARTIFACT_BYTES,
  publishArtifactTool,
} from '../../../src/tools/publishArtifact/publishArtifact.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-publish-artifact-'));
  initManifest(runDir, 'publish generic artifacts');
  mkdirSync(join(runDir, 'scratch/workspace'), { recursive: true });
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function call(
  input: unknown,
  options: { browser?: BrowserController; abortSignal?: AbortSignal } = {},
) {
  return executeToolCall(
    createRegistry([publishArtifactTool]),
    { id: 'publish-1', name: 'publish_artifact', input },
    { runDir, ...options },
  );
}

async function successfulCall(
  input: unknown,
  options: { browser?: BrowserController; abortSignal?: AbortSignal } = {},
): Promise<ManifestEntry> {
  const result = await call(input, options);
  if (result.isError) throw new Error(result.content);
  return JSON.parse(result.content) as ManifestEntry;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface FakeBrowserOptions {
  screenshotBytes?: Uint8Array;
  downloadBytes?: Uint8Array;
  finalUrl?: string;
  status?: number;
  sourceUrl?: string;
  screenshotPromise?: Promise<Uint8Array>;
}

function fakeBrowser(options: FakeBrowserOptions = {}) {
  const screenshot = vi.fn(
    () =>
      options.screenshotPromise ??
      Promise.resolve(options.screenshotBytes ?? Buffer.from('png bytes')),
  );
  const download = vi.fn(async () => ({
    finalUrl: options.finalUrl ?? 'https://files.example.test/final.bin',
    ...(options.status === undefined ? {} : { status: options.status }),
    headers: { 'content-type': 'application/octet-stream' },
    bytes: options.downloadBytes ?? Buffer.from([0, 255, 12, 13]),
    suggestedFilename: 'final.bin',
  }));
  const currentUrl = vi.fn(() => options.sourceUrl ?? 'https://source.example.test/report');
  const browser = {
    screenshot,
    download,
    currentUrl,
  } as unknown as BrowserController;
  return { browser, screenshot, download, currentUrl };
}

describe('publish_artifact schema', () => {
  it('serializes as one strict top-level object and enforces each conditional mode', async () => {
    const [definition] = toApiToolDefs(createRegistry([publishArtifactTool]));
    expect(definition?.input_schema.type).toBe('object');
    expect(definition?.input_schema).not.toHaveProperty('anyOf');
    expect(definition?.input_schema.additionalProperties).toBe(false);

    const invalidInputs: unknown[] = [
      {
        kind: 'file',
        artifact_path: 'artifacts/a.bin',
        roles: ['evidence'],
      },
      {
        kind: 'text',
        artifact_path: 'artifacts/a.txt',
        roles: ['evidence'],
        content: 'a',
        source_path: 'scratch/workspace/a.txt',
      },
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/a.png',
        roles: ['evidence'],
        source_url: 'https://spoof.example.test/',
      },
      {
        kind: 'download',
        artifact_path: 'artifacts/a.bin',
        roles: ['evidence'],
      },
      {
        kind: 'download',
        artifact_path: 'artifacts/a.bin',
        roles: ['evidence'],
        url: 'https://example.test/a',
        backend_node_id: 73,
      },
      {
        kind: 'download',
        artifact_path: 'artifacts/a.bin',
        roles: ['evidence'],
        backend_node_id: 0,
      },
      {
        kind: 'download',
        artifact_path: 'artifacts/a.bin',
        roles: ['evidence'],
        backend_node_id: 1.5,
      },
      {
        kind: 'text',
        artifact_path: 'artifacts/a.txt',
        roles: [],
        content: 'a',
      },
      {
        kind: 'text',
        artifact_path: 'artifacts/a.txt',
        roles: ['evidence', 'evidence'],
        content: 'a',
      },
      {
        kind: 'text',
        artifact_path: 'artifacts/a.txt',
        roles: ['evidence'],
        content: 'a',
        unexpected: true,
      },
    ];

    for (const input of invalidInputs) {
      const result = await call(input);
      if (!result.isError) {
        throw new Error(`expected invalid input: ${JSON.stringify(input)}`);
      }
      expect(result.errorKind, JSON.stringify(input)).toBe('invalid_input');
    }
  });
});

describe('publish_artifact file and text modes', () => {
  it('writes exact UTF-8 text, canonical roles, provenance, hash, and returns the manifest entry', async () => {
    const content = 'Résumé — 東京 🕵️\n';
    const expected = Buffer.from(content, 'utf8');
    const entry = await successfulCall({
      kind: 'text',
      artifact_path: './artifacts/report.md',
      roles: ['evidence', 'requested_output'],
      source_url: 'https://example.test/source',
      content,
    });

    expect(readFileSync(join(runDir, entry.filename))).toEqual(expected);
    expect(entry).toMatchObject({
      filename: 'artifacts/report.md',
      sha256: sha256(expected),
      sourceUrl: 'https://example.test/source',
      roles: ['requested_output', 'evidence'],
    });
    expect(readManifest(runDir).artifacts).toEqual([entry]);
  });

  it('copies arbitrary workspace bytes exactly and rejects every other source area', async () => {
    const source = join(runDir, 'scratch/workspace/raw.bin');
    const bytes = Buffer.from([0, 1, 2, 255, 0, 128, 10]);
    writeFileSync(source, bytes);

    const entry = await successfulCall({
      kind: 'file',
      artifact_path: 'artifacts/raw.bin',
      roles: ['requested_output'],
      source_path: 'scratch/workspace/raw.bin',
    });
    expect(readFileSync(join(runDir, entry.filename))).toEqual(bytes);
    expect(entry.sha256).toBe(sha256(bytes));

    writeFileSync(join(runDir, 'scratch/outside.bin'), bytes);
    for (const sourcePath of [
      'raw.bin',
      'workspace/raw.bin',
      './scratch/workspace/raw.bin',
      'scratch/workspace/./raw.bin',
      'scratch/outside.bin',
      'scratch/workspace/../../scratch/outside.bin',
      '../outside.bin',
    ]) {
      const result = await call({
        kind: 'file',
        artifact_path: 'artifacts/refused.bin',
        roles: ['evidence'],
        source_path: sourcePath,
      });
      expect(result.isError).toBe(true);
      if (result.isError) {
        expect(result.errorKind).toBe('invalid_input');
        expect(result.content).toContain('scratch/workspace/report.csv');
      }
      expect(existsSync(join(runDir, 'artifacts/refused.bin'))).toBe(false);
    }
  });

  it('rejects source symlinks, symlink ancestors, directories, and oversized files', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'sherlock-publish-external-'));
    try {
      writeFileSync(join(externalDir, 'secret.bin'), 'secret');
      symlinkSync(join(externalDir, 'secret.bin'), join(runDir, 'scratch/workspace/file-link.bin'));
      symlinkSync(externalDir, join(runDir, 'scratch/workspace/dir-link'));
      mkdirSync(join(runDir, 'scratch/workspace/a-directory'));
      const oversized = join(runDir, 'scratch/workspace/oversized.bin');
      writeFileSync(oversized, '');
      truncateSync(oversized, MAX_PUBLISH_ARTIFACT_BYTES + 1);

      for (const sourcePath of [
        'scratch/workspace/file-link.bin',
        'scratch/workspace/dir-link/secret.bin',
        'scratch/workspace/a-directory',
        'scratch/workspace/oversized.bin',
      ]) {
        const result = await call({
          kind: 'file',
          artifact_path: 'artifacts/refused.bin',
          roles: ['evidence'],
          source_path: sourcePath,
        });
        expect(result.isError, sourcePath).toBe(true);
        expect(existsSync(join(runDir, 'artifacts/refused.bin'))).toBe(false);
      }
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('confines destinations to artifacts and refuses symlinked or unmanifested targets', async () => {
    const external = join(tmpdir(), `sherlock-destination-${process.pid}.txt`);
    writeFileSync(external, 'outside');
    try {
      symlinkSync(external, join(runDir, 'artifacts/link.txt'));
      mkdirSync(join(runDir, 'artifacts/link-parent'));
      symlinkSync(tmpdir(), join(runDir, 'artifacts/link-parent/child'));
      writeFileSync(join(runDir, 'artifacts/untracked.txt'), 'untracked');

      for (const artifactPath of [
        'scratch/no.txt',
        '../escape.txt',
        'artifacts',
        'artifacts/link.txt',
        'artifacts/link-parent/child/no.txt',
        'artifacts/untracked.txt',
      ]) {
        const result = await call({
          kind: 'text',
          artifact_path: artifactPath,
          roles: ['evidence'],
          content: 'replacement',
        });
        expect(result.isError, artifactPath).toBe(true);
      }
      expect(readFileSync(external, 'utf8')).toBe('outside');
      expect(readFileSync(join(runDir, 'artifacts/untracked.txt'), 'utf8')).toBe('untracked');
    } finally {
      rmSync(external, { force: true });
    }
  });

  it('allows overwrite only for the same normalized role set', async () => {
    writeArtifact(runDir, 'artifacts/answer.txt', Buffer.from('old'), {
      roles: ['evidence', 'requested_output'],
    });

    const updated = await successfulCall({
      kind: 'text',
      artifact_path: 'artifacts/answer.txt',
      roles: ['requested_output', 'evidence'],
      content: 'new',
    });
    expect(readFileSync(join(runDir, updated.filename), 'utf8')).toBe('new');
    expect(readManifest(runDir).artifacts).toHaveLength(1);

    const refused = await call({
      kind: 'text',
      artifact_path: 'artifacts/answer.txt',
      roles: ['evidence'],
      content: 'must not replace',
    });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('do not match requested roles');
    expect(readFileSync(join(runDir, updated.filename), 'utf8')).toBe('new');
  });
});

describe('publish_artifact browser modes', () => {
  it('checks destination policy before browser acquisition', async () => {
    writeFileSync(join(runDir, 'artifacts/untracked.png'), 'unmanifested');
    const fake = fakeBrowser();

    const result = await call(
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/untracked.png',
        roles: ['evidence'],
      },
      { browser: fake.browser },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unmanifested file');
    expect(fake.currentUrl).not.toHaveBeenCalled();
    expect(fake.screenshot).not.toHaveBeenCalled();
  });

  it('revalidates destination policy after browser acquisition', async () => {
    const destination = join(runDir, 'artifacts/raced.png');
    const fake = fakeBrowser();
    fake.screenshot.mockImplementationOnce(async () => {
      writeFileSync(destination, 'appeared during capture');
      return Buffer.from('captured bytes');
    });

    const result = await call(
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/raced.png',
        roles: ['evidence'],
      },
      { browser: fake.browser },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unmanifested file');
    expect(readFileSync(destination, 'utf8')).toBe('appeared during capture');
    expect(readManifest(runDir).artifacts).toEqual([]);
  });

  it('captures provider-neutral screenshot bytes and browser-derived source metadata', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    const fake = fakeBrowser({ screenshotBytes: png });
    const entry = await successfulCall(
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/page.png',
        roles: ['evidence'],
        page_id: 'page-2',
        full_page: true,
      },
      { browser: fake.browser },
    );

    expect(fake.currentUrl).toHaveBeenCalledWith('page-2');
    expect(fake.screenshot).toHaveBeenCalledWith({
      pageId: 'page-2',
      fullPage: true,
    });
    expect(readFileSync(join(runDir, entry.filename))).toEqual(png);
    expect(entry).toMatchObject({
      sha256: sha256(png),
      sourceUrl: 'https://source.example.test/report',
      roles: ['evidence'],
    });
  });

  it('downloads exact bytes by URL or backend node and records final/initiating provenance', async () => {
    const directBytes = Buffer.from([0, 255, 7, 8]);
    const direct = fakeBrowser({ downloadBytes: directBytes });
    const directEntry = await successfulCall(
      {
        kind: 'download',
        artifact_path: 'artifacts/direct.bin',
        roles: ['requested_output'],
        page_id: 'page-direct',
        url: 'https://files.example.test/start.bin',
      },
      { browser: direct.browser },
    );
    expect(direct.download).toHaveBeenCalledWith({
      pageId: 'page-direct',
      url: 'https://files.example.test/start.bin',
    });
    expect(readFileSync(join(runDir, directEntry.filename))).toEqual(directBytes);
    expect(directEntry.sourceUrl).toBe('https://files.example.test/final.bin');

    const generated = fakeBrowser({ finalUrl: 'blob:generated-download' });
    const generatedEntry = await successfulCall(
      {
        kind: 'download',
        artifact_path: 'artifacts/generated.bin',
        roles: ['evidence'],
        backend_node_id: 73,
      },
      { browser: generated.browser },
    );
    expect(generated.download).toHaveBeenCalledWith({ backendNodeId: 73 });
    expect(generatedEntry.sourceUrl).toBe('https://source.example.test/report');
  });

  it('rejects failed HTTP responses without publishing bytes', async () => {
    const fake = fakeBrowser({ status: 404 });
    const result = await call(
      {
        kind: 'download',
        artifact_path: 'artifacts/missing.bin',
        roles: ['evidence'],
        url: 'https://files.example.test/missing.bin',
      },
      { browser: fake.browser },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('HTTP 404');
    expect(existsSync(join(runDir, 'artifacts/missing.bin'))).toBe(false);
    expect(readManifest(runDir).artifacts).toEqual([]);
  });

  it('requires a browser only for browser-backed modes', async () => {
    await expect(
      successfulCall({
        kind: 'text',
        artifact_path: 'artifacts/local.txt',
        roles: ['evidence'],
        content: 'local',
      }),
    ).resolves.toMatchObject({ filename: 'artifacts/local.txt' });

    for (const input of [
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/no-browser.png',
        roles: ['evidence'],
      },
      {
        kind: 'download',
        artifact_path: 'artifacts/no-browser.bin',
        roles: ['evidence'],
        url: 'https://example.test/file.bin',
      },
    ]) {
      const result = await call(input);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('active browser session');
    }
  });
});

describe('publish_artifact cancellation', () => {
  it('does no filesystem or browser work when already cancelled', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const fake = fakeBrowser();

    const result = await call(
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/cancelled.png',
        roles: ['evidence'],
      },
      { browser: fake.browser, abortSignal: abortController.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('cancelled');
    expect(fake.currentUrl).not.toHaveBeenCalled();
    expect(fake.screenshot).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'artifacts/cancelled.png'))).toBe(false);
  });

  it('does not publish a slow browser capture that finishes after cancellation', async () => {
    let resolveScreenshot!: (bytes: Uint8Array) => void;
    const screenshotPromise = new Promise<Uint8Array>((resolvePromise) => {
      resolveScreenshot = resolvePromise;
    });
    const fake = fakeBrowser({ screenshotPromise });
    const abortController = new AbortController();

    const pending = call(
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/cancelled-late.png',
        roles: ['evidence'],
      },
      { browser: fake.browser, abortSignal: abortController.signal },
    );
    await vi.waitFor(() => expect(fake.screenshot).toHaveBeenCalledOnce());
    abortController.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cancelled');
    expect(existsSync(join(runDir, 'artifacts/cancelled-late.png'))).toBe(false);

    resolveScreenshot(Buffer.from('late bytes'));
    await Promise.resolve();
    expect(existsSync(join(runDir, 'artifacts/cancelled-late.png'))).toBe(false);
    expect(readManifest(runDir).artifacts).toEqual([]);
  });
});
