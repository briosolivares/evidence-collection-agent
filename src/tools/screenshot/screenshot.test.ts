import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import type { EvidenceResult } from '../shared/evidence.js';
import { screenshotTool } from './screenshot.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('screenshot tool', () => {
  const suite = setupBrowserToolSuite('screenshot-tool');
  const registry = createRegistry([...observationTools, screenshotTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  async function successfulCall(name: string, input: unknown) {
    const result = await call(name, input);
    if (result.isError) throw new Error(result.content);
    return result.content;
  }

  beforeEach(async () => {
    await successfulCall('navigate', { url: suite.server().url('/') });
    await successfulCall('navigate', { url: suite.server().url('/downloads.html') });
  });

  it(
    'writes viewport and full-page PNGs with hashes and source provenance',
    async () => {
      const viewportResult = JSON.parse(
        await successfulCall('screenshot', { filename: 'artifacts/viewport.png' }),
      ) as EvidenceResult;
      const fullPageResult = JSON.parse(
        await successfulCall('screenshot', {
          filename: 'artifacts/full-page.png',
          fullPage: true,
        }),
      ) as EvidenceResult;

      const viewportBytes = readFileSync(join(suite.runDir(), viewportResult.path));
      const fullPageBytes = readFileSync(join(suite.runDir(), fullPageResult.path));
      expect(viewportBytes.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
      expect(fullPageBytes.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
      expect(viewportResult).toEqual({
        path: 'artifacts/viewport.png',
        size: viewportBytes.byteLength,
      });
      expect(fullPageResult).toEqual({
        path: 'artifacts/full-page.png',
        size: fullPageBytes.byteLength,
      });
      expect(pngHeight(fullPageBytes)).toBeGreaterThan(pngHeight(viewportBytes));

      const manifest = readManifest(suite.runDir());
      for (const [path, bytes] of [
        [viewportResult.path, viewportBytes],
        [fullPageResult.path, fullPageBytes],
      ] as const) {
        expect(manifest.artifacts).toContainEqual(
          expect.objectContaining({
            filename: path,
            sha256: sha256(bytes),
            sourceUrl: suite.server().url('/downloads.html'),
            roles: ['evidence'],
          }),
        );
      }
      expect(screenshotTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'records requested_output alongside evidence when the capture was explicitly asked for',
    async () => {
      const result = JSON.parse(
        await successfulCall('screenshot', {
          filename: 'artifacts/requested.png',
          roles: ['requested_output', 'evidence'],
        }),
      ) as EvidenceResult;

      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: result.path,
          roles: ['requested_output', 'evidence'],
        }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects scratch/ paths — captures always publish — without corrupting the manifest',
    async () => {
      const result = await call('screenshot', {
        filename: 'scratch/hidden.png',
      });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('artifacts/');
      expect(readManifest(suite.runDir()).artifacts).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects reserved run metadata paths without corrupting the manifest',
    async () => {
      const result = await call('screenshot', {
        filename: 'nested/../manifest.json',
      });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toMatch(/reserved.*metadata/i);
      expect(readManifest(suite.runDir()).artifacts).toEqual([]);
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
