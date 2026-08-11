import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BrowserAdapter } from '../browser/adapter.js';
import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
import {
  initManifest,
  MANIFEST_FILENAME,
  type Manifest,
} from '../run/artifacts.js';
import { downloadTool, evidenceTools, screenshotTool } from './evidenceTools.js';
import { observationTools } from './observationTools.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry } from './registry.js';
import {
  startFixtureServer,
  type FixtureServer,
} from '../../tests/fixtures/server.js';

const BROWSER_TEST_TIMEOUT_MS = 15_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AUTHENTICATED_BYTES = Buffer.from('browser-session-authenticated\n');

interface EvidenceResult {
  path: string;
  size: number;
}

function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(
    new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`),
  );

  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName} in:\n${outline}`);
  }
  return match[1];
}

describe('browser evidence tools', () => {
  let adapter: BrowserAdapter;
  let fixtureServer: FixtureServer;
  let profileDir: string;
  let runDir: string;

  const registry = createRegistry([...observationTools, ...evidenceTools]);

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), 'evidence-tools-chrome-'));
    adapter = await launchPersistentChrome({ profileDir, headless: true });
  }, 30_000);

  beforeEach(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'evidence-tools-run-'));
    initManifest(runDir, 'test browser evidence tools');
    await adapter.newTab();
    await successfulCall('navigate', { url: fixtureServer.url('/') });
    await successfulCall('navigate', { url: fixtureServer.url('/downloads.html') });
  });

  afterEach(async () => {
    await adapter.closeTab();
    rmSync(runDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await adapter?.close();
    await fixtureServer?.close();
    if (profileDir !== undefined) {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir, browser: adapter },
    );
  }

  async function successfulCall(name: string, input: unknown) {
    const result = await call(name, input);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }

  it(
    'writes viewport and full-page PNGs with hashes and source provenance',
    async () => {
      const viewportResult = JSON.parse(
        await successfulCall('screenshot', { filename: 'evidence/viewport.png' }),
      ) as EvidenceResult;
      const fullPageResult = JSON.parse(
        await successfulCall('screenshot', {
          filename: 'evidence/full-page.png',
          fullPage: true,
        }),
      ) as EvidenceResult;

      const viewportBytes = readFileSync(join(runDir, viewportResult.path));
      const fullPageBytes = readFileSync(join(runDir, fullPageResult.path));
      expect(viewportBytes.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
      expect(fullPageBytes.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
      expect(viewportResult).toEqual({
        path: 'evidence/viewport.png',
        size: viewportBytes.byteLength,
      });
      expect(fullPageResult).toEqual({
        path: 'evidence/full-page.png',
        size: fullPageBytes.byteLength,
      });
      expect(pngHeight(fullPageBytes)).toBeGreaterThan(pngHeight(viewportBytes));

      const manifest = readManifest(runDir);
      for (const [path, bytes] of [
        [viewportResult.path, viewportBytes],
        [fullPageResult.path, fullPageBytes],
      ] as const) {
        expect(manifest.artifacts).toContainEqual(
          expect.objectContaining({
            filename: path,
            sha256: sha256(bytes),
            sourceUrl: fixtureServer.url('/downloads.html'),
          }),
        );
      }
      expect(screenshotTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'downloads exact authenticated bytes with a URL-derived name and provenance',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'link "Download authenticated evidence"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('authenticated.bin');
      const savedBytes = readFileSync(join(runDir, result.path));
      expect(savedBytes).toEqual(AUTHENTICATED_BYTES);
      expect(result.size).toBe(AUTHENTICATED_BYTES.byteLength);
      expect(readManifest(runDir).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'authenticated.bin',
          sha256: sha256(AUTHENTICATED_BYTES),
          sourceUrl: fixtureServer.url('/downloads.html'),
        }),
      );
      expect(downloadTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'returns a structured error for a ref whose element has no href',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'button "Generate download with JavaScript"');
      const result = await call('download', { ref, filename: 'should-not-exist.bin' });

      expect(result).toMatchObject({
        toolCallId: 'call-download',
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('has no href');
      expect(result.content).toContain('re-run inspect_page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects reserved run metadata paths without corrupting the manifest',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const linkRef = refFor(outline, 'link "Download authenticated evidence"');

      const screenshot = await call('screenshot', {
        filename: 'nested/../manifest.json',
      });
      const download = await call('download', {
        ref: linkRef,
        filename: 'transcript.jsonl',
      });

      for (const result of [screenshot, download]) {
        expect(result).toMatchObject({
          isError: true,
          errorKind: 'execution_error',
        });
        expect(result.content).toMatch(/reserved.*metadata/i);
      }
      expect(readManifest(runDir).artifacts).toEqual([]);
      expect(existsSync(join(runDir, 'transcript.jsonl'))).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});

function readManifest(runDir: string): Manifest {
  return JSON.parse(
    readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'),
  ) as Manifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pngHeight(bytes: Uint8Array): number {
  if (!Buffer.from(bytes.subarray(0, PNG_MAGIC.byteLength)).equals(PNG_MAGIC)) {
    throw new Error('Not a PNG file');
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG is missing its initial IHDR chunk');
  }
  return view.readUInt32BE(20);
}
