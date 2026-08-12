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
const BROWSER_NATIVE_BYTES = Buffer.from('browser-native-download\n');
const BROWSER_DOCUMENT_BYTES = Buffer.from(
  '<!doctype html><title>Browser-only filing</title><p>Exact filing bytes</p>\n',
);

describe('download tool', () => {
  const suite = setupBrowserToolSuite('download-tool');
  const registry = createRegistry([...observationTools, downloadTool]);

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
    'downloads exact authenticated bytes with a URL-derived name and provenance',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'link "Download authenticated evidence"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/authenticated.bin');
      const savedBytes = readFileSync(join(suite.runDir(), result.path));
      expect(savedBytes).toEqual(AUTHENTICATED_BYTES);
      expect(result.size).toBe(AUTHENTICATED_BYTES.byteLength);
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'artifacts/authenticated.bin',
          sha256: sha256(AUTHENTICATED_BYTES),
          sourceUrl: suite.server().url('/authenticated.bin'),
          roles: ['evidence'],
        }),
      );
      expect(downloadTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'captures an inline document through Chrome when direct HTTP is blocked',
    async () => {
      const url = suite.server().url('/browser-only-document.htm');
      await expect(suite.controller().fetch(url)).resolves.toMatchObject({ status: 403 });

      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'link "View browser-only document"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/browser-only-document.htm');
      expect(readFileSync(join(suite.runDir(), result.path))).toEqual(
        BROWSER_DOCUMENT_BYTES,
      );
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'artifacts/browser-only-document.htm',
          sha256: sha256(BROWSER_DOCUMENT_BYTES),
          sourceUrl: url,
        }),
      );
      expect(suite.controller().currentUrl()).toBe(suite.server().url('/downloads.html'));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'accepts a verified direct URL for bypassing a viewer wrapper',
    async () => {
      const url = suite.server().url('/browser-only-document.htm');
      const result = JSON.parse(
        await successfulCall('download', {
          url,
          filename: 'artifacts/raw-filing.htm',
        }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/raw-filing.htm');
      expect(readFileSync(join(suite.runDir(), result.path))).toEqual(
        BROWSER_DOCUMENT_BYTES,
      );
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({ filename: 'artifacts/raw-filing.htm', sourceUrl: url }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'uses the browser-suggested filename for an attachment response',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'link "Download browser-only evidence"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/browser-evidence.bin');
      expect(readFileSync(join(suite.runDir(), result.path))).toEqual(
        BROWSER_NATIVE_BYTES,
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'captures a JavaScript-triggered browser download from a ref without an href',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'button "Generate download with JavaScript"');
      const result = JSON.parse(
        await successfulCall('download', { ref }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/javascript-evidence.bin');
      expect(readFileSync(join(suite.runDir(), result.path))).toEqual(
        BROWSER_NATIVE_BYTES,
      );
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'artifacts/javascript-evidence.bin',
          sourceUrl: suite.server().url('/downloads.html'),
        }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'records requested_output alongside evidence when the file was explicitly asked for',
    async () => {
      const url = suite.server().url('/browser-only-document.htm');
      await successfulCall('download', {
        url,
        filename: 'artifacts/requested-filing.htm',
        roles: ['requested_output', 'evidence'],
      });

      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: 'artifacts/requested-filing.htm',
          roles: ['requested_output', 'evidence'],
        }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects scratch/ output paths — downloads always publish — writing nothing',
    async () => {
      const result = await call('download', {
        url: suite.server().url('/browser-only-document.htm'),
        filename: 'scratch/hidden.htm',
      });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('artifacts/');
      expect(readManifest(suite.runDir()).artifacts).toEqual([]);
      expect(existsSync(join(suite.runDir(), 'scratch/hidden.htm'))).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'returns a structured error for a ref that does not start a download',
    async () => {
      const outline = await successfulCall('inspect_page', {});
      const ref = refFor(outline, 'button "Do nothing"');
      const result = await call('download', { ref, filename: 'artifacts/should-not-exist.bin' });

      expect(result).toMatchObject({
        toolCallId: 'call-download',
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('did not start a browser download');
      expect(result.content).toContain('Re-run inspect_page');
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
