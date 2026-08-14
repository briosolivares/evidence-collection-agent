import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { browserActionTool } from '../browserAction/browserAction.js';
import { executeToolCall } from '../pipeline.js';
import { accessesConflict, createRegistry } from '../registry.js';
import type { OutputContract } from '../../contracts/outputContract.js';
import type { EvidenceResult } from '../shared/evidence.js';
import { createScreenshotTool } from './screenshot.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('screenshot tool', () => {
  const suite = setupBrowserToolSuite('screenshot-tool');
  // The contract the tool consults, swappable per test. Default: a run whose
  // contract asks for no screenshots, which is the contract-less baseline.
  let contract: OutputContract | undefined;
  const screenshotTool = createScreenshotTool({ contract: () => contract });
  const registry = createRegistry([screenshotTool]);

  /** A contract declaring one screenshots output, optionally name-patterned. */
  const screenshotsContract = (filenamePattern?: string): OutputContract =>
    ({
      outputs: [
        {
          id: 'shots',
          kind: 'screenshots',
          count: { minimum: 1 },
          ...(filenamePattern === undefined ? {} : { filenamePattern }),
        },
      ],
    }) as OutputContract;

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
    contract = undefined;
    await suite.controller().goto(suite.server().url('/'));
    await suite.controller().goto(suite.server().url('/downloads.html'));
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
      // State-changing: writes the named file and the manifest.
      expect(screenshotTool.getAccess({ filename: 'artifacts/x.png' }).writes).toEqual([
        'file:artifacts/x.png',
        'manifest',
      ]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'derives requested_output from the contract, with no roles supplied',
    async () => {
      // The contract — not the model's self-report — decides whether a capture
      // is a deliverable. Graders select deliverables from exactly these
      // manifest entries, so a self-reported role was a claim nothing checked.
      contract = screenshotsContract();
      const result = JSON.parse(
        await successfulCall('screenshot', { filename: 'artifacts/requested.png' }),
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
    'refuses a requested_output claim a contract with no screenshots cannot support',
    async () => {
      const result = await call('screenshot', {
        filename: 'artifacts/overclaimed.png',
        roles: ['requested_output', 'evidence'],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('declares no screenshots output');
      expect(result.content).toContain('set_output_contract');
      // Nothing was published on the refused path.
      expect(readManifest(suite.runDir()).artifacts).not.toContainEqual(
        expect.objectContaining({ filename: 'artifacts/overclaimed.png' }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a filename the contract pattern rules out, before writing it',
    async () => {
      // A published artifact cannot be renamed, so catching this at capture
      // time costs one turn; the submission checks used to catch it only after
      // every capture had already been taken under the wrong name.
      contract = screenshotsContract('profile-*.png');
      const result = await call('screenshot', { filename: 'artifacts/wrong-name.png' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('profile-*.png');
      expect(readManifest(suite.runDir()).artifacts).not.toContainEqual(
        expect.objectContaining({ filename: 'artifacts/wrong-name.png' }),
      );
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'accepts a filename the contract pattern allows',
    async () => {
      contract = screenshotsContract('profile-*.png');
      const result = JSON.parse(
        await successfulCall('screenshot', { filename: 'artifacts/profile-alice.png' }),
      ) as EvidenceResult;

      expect(result.path).toBe('artifacts/profile-alice.png');
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

  it(
    'captures a named page that is not the selected one, recording that page\'s own URL',
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

      const result = JSON.parse(
        await successfulCall('screenshot', { filename: 'artifacts/popup.png', pageId: popupId }),
      ) as EvidenceResult;

      const bytes = readFileSync(join(suite.runDir(), result.path));
      expect(bytes.subarray(0, PNG_MAGIC.byteLength)).toEqual(PNG_MAGIC);
      expect(readManifest(suite.runDir()).artifacts).toContainEqual(
        expect.objectContaining({
          filename: result.path,
          sourceUrl: suite.server().url('/second.html'),
        }),
      );
      // The selected page never moved for this call.
      expect(suite.controller().currentUrl()).toBe(suite.server().url('/downloads.html'));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it('scopes access to the named page: a different page\'s browser_action never conflicts, the same page\'s does', () => {
    const screenshotOnP1 = screenshotTool.getAccess({ filename: 'artifacts/x.png', pageId: 'p1' });
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

    // Same page named by both calls: the screenshot's read of page:p1
    // conflicts with browser_action's write of page:p1.
    expect(accessesConflict(screenshotOnP1, actionOnP1)).toBe(true);
    // A different, explicitly named page: no overlap at all.
    expect(accessesConflict(screenshotOnP1, actionOnP2)).toBe(false);
    // A named page never collides with unrelated work on the task tab.
    expect(accessesConflict(screenshotOnP1, actionOnTaskTab)).toBe(false);

    // The inverse must also hold: an unqualified (selected-page) screenshot
    // DOES collide with unqualified (selected-page) browser_action work.
    const screenshotOnSelected = screenshotTool.getAccess({ filename: 'artifacts/y.png' });
    expect(accessesConflict(screenshotOnSelected, actionOnTaskTab)).toBe(true);
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
