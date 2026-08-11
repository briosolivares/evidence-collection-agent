import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { refFor } from '../../../tests/helpers/outline.js';
import { MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { observationTools } from '../index.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import type { EvidenceResult } from '../shared/evidence.js';
import { downloadTool } from './download.js';

const AUTHENTICATED_BYTES = Buffer.from('browser-session-authenticated\n');

describe('download tool', () => {
  const suite = setupBrowserToolSuite('download-tool');
  const registry = createRegistry([...observationTools, downloadTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.adapter() },
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
    'downloads exact authenticated bytes with a URL-derived name and provenance',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'link "Download authenticated evidence"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('authenticated.bin');
      const savedBytes = readFileSync(join(suite.runDir(), result.path));
      expect(savedBytes).toEqual(AUTHENTICATED_BYTES);
      expect(result.size).toBe(AUTHENTICATED_BYTES.byteLength);
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'authenticated.bin',
          sha256: sha256(AUTHENTICATED_BYTES),
          sourceUrl: suite.server().url('/downloads.html'),
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

      const result = await call('download', {
        ref: linkRef,
        filename: 'transcript.jsonl',
      });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toMatch(/reserved.*metadata/i);
      expect(readManifest(suite.runDir()).artifacts).toEqual([]);
      expect(existsSync(join(suite.runDir(), 'transcript.jsonl'))).toBe(false);
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
