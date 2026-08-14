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
import { browserActionTool } from '../browserAction/browserAction.js';
import { executeToolCall } from '../pipeline.js';
import { accessesConflict, createRegistry } from '../registry.js';
import type { EvidenceResult } from '../shared/evidence.js';
import { downloadTool } from './download.js';

const AUTHENTICATED_BYTES = Buffer.from('browser-session-authenticated\n');
const BROWSER_NATIVE_BYTES = Buffer.from('browser-native-download\n');
const BROWSER_DOCUMENT_BYTES = Buffer.from(
  '<!doctype html><title>Browser-only filing</title><p>Exact filing bytes</p>\n',
);

describe('download tool', () => {
  const suite = setupBrowserToolSuite('download-tool');
  const registry = createRegistry([downloadTool]);

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
    await suite.controller().goto(suite.server().url('/'));
    await suite.controller().goto(suite.server().url('/downloads.html'));
  });

  it(
    'downloads exact authenticated bytes with a URL-derived name and provenance',
    async () => {
      const outline = await suite.controller().outline();
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
      // State-changing: always writes the manifest, regardless of input.
      expect(downloadTool.getAccess({}).writes).toContain('manifest');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'captures an inline document through Chrome when direct HTTP is blocked',
    async () => {
      const url = suite.server().url('/browser-only-document.htm');
      await expect(suite.controller().fetch(url)).resolves.toMatchObject({ status: 403 });

      const outline = await suite.controller().outline();
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
      const outline = await suite.controller().outline();
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
      const outline = await suite.controller().outline();
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
      const outline = await suite.controller().outline();
      const ref = refFor(outline, 'button "Do nothing"');
      const result = await call('download', { ref, filename: 'artifacts/should-not-exist.bin' });

      expect(result).toMatchObject({
        toolCallId: 'call-download',
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('did not start a browser download');
      expect(result.content).toContain('Observe the page again');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects reserved run metadata paths without corrupting the manifest',
    async () => {
      const outline = await suite.controller().outline();
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

  it(
    'downloads through a named page that is not the selected one',
    async () => {
      // Open a popup while the task tab briefly visits popup.html, then move
      // the task tab back to downloads.html — the popup stays open as a
      // genuinely different, non-selected page for the rest of the test.
      await suite.controller().goto(suite.server().url('/popup.html'));
      const observation = await suite.controller().observe({ need: ['interactive'] });
      const link = observation.elements.find(
        (element) => element.role === 'link' && element.name === 'Open popup fixture',
      );
      if (link === undefined) throw new Error('Open popup fixture link not found');
      const opened = await suite.controller().browserAction({
        actions: [{ op: 'click', target: link }],
        runDir: suite.runDir(),
      });
      const popupId = opened.openedPages[0]?.pageId;
      if (popupId === undefined) throw new Error('browser_action did not report an opened page');
      await suite.controller().goto(suite.server().url('/downloads.html'));
      expect(suite.controller().currentUrl()).toBe(suite.server().url('/downloads.html'));
      expect(suite.controller().currentUrl(popupId)).toBe(suite.server().url('/second.html'));

      const url = suite.server().url('/browser-only-document.htm');
      const result = JSON.parse(
        await successfulCall('download', {
          url,
          pageId: popupId,
          filename: 'artifacts/from-popup.htm',
        }),
      ) as EvidenceResult;

      expect(readFileSync(join(suite.runDir(), result.path))).toEqual(BROWSER_DOCUMENT_BYTES);
      // The selected page never moved off downloads.html for this call.
      expect(suite.controller().currentUrl()).toBe(suite.server().url('/downloads.html'));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'fails distinctly for an unknown pageId, proving pageId reaches the browser rather than silently falling back to the selected page',
    async () => {
      const result = await call('download', {
        url: suite.server().url('/browser-only-document.htm'),
        pageId: 'no-such-page',
        filename: 'artifacts/should-not-exist.htm',
      });

      expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(result.content).toContain('no-such-page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it('scopes access to the named page: a different page\'s browser_action never conflicts, the same page\'s does', () => {
    const downloadOnP1 = downloadTool.getAccess({ url: 'https://example.test/x', pageId: 'p1' });
    const actionOnP1 = browserActionTool.getAccess({
      pageId: 'p1',
      actions: [{ op: 'navigate', url: 'https://example.test' }],
    });
    const actionOnP2 = browserActionTool.getAccess({
      pageId: 'p2',
      actions: [{ op: 'navigate', url: 'https://example.test' }],
    });
    const actionOnTaskTab = browserActionTool.getAccess({
      actions: [{ op: 'navigate', url: 'https://example.test' }],
    });

    expect(accessesConflict(downloadOnP1, actionOnP1)).toBe(true);
    expect(accessesConflict(downloadOnP1, actionOnP2)).toBe(false);
    expect(accessesConflict(downloadOnP1, actionOnTaskTab)).toBe(false);

    const downloadOnSelected = downloadTool.getAccess({ url: 'https://example.test/y' });
    expect(accessesConflict(downloadOnSelected, actionOnTaskTab)).toBe(true);
  });
});

function readManifest(runDir: string): Manifest {
  return JSON.parse(
    readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'),
  ) as Manifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
