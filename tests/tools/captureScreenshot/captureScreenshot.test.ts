import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../../src/browser/controller.js';
import { initManifest, readManifest } from '../../../src/run/artifacts.js';
import {
  captureScreenshotTool,
  CAPTURE_SCREENSHOT_TOOL_NAME,
} from '../../../src/tools/captureScreenshot/captureScreenshot.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry, toApiToolDefs } from '../../../src/tools/registry.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'capture-screenshot-test-'));
  initManifest(runDir, 'inspect the live viewport');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeBrowser(bytes: Uint8Array = ONE_PIXEL_PNG) {
  const screenshot = vi.fn(async () => bytes);
  const currentUrl = vi.fn(() => 'https://sheets.example.test/edit#gid=0');
  return {
    browser: { screenshot, currentUrl } as unknown as BrowserController,
    screenshot,
    currentUrl,
  };
}

function call(input: unknown, browser?: BrowserController) {
  return executeToolCall(
    createRegistry([captureScreenshotTool]),
    { id: 'capture-1', name: CAPTURE_SCREENSHOT_TOOL_NAME, input },
    { runDir, ...(browser === undefined ? {} : { browser }) },
  );
}

describe('capture_screenshot', () => {
  it('has one strict provider-neutral input schema', () => {
    const [definition] = toApiToolDefs(createRegistry([captureScreenshotTool]));
    expect(definition).toMatchObject({
      name: CAPTURE_SCREENSHOT_TOOL_NAME,
      input_schema: {
        type: 'object',
        additionalProperties: false,
      },
    });
    expect(definition?.input_schema).not.toHaveProperty('anyOf');
  });

  it('returns CSS-scale viewport pixels inline without publishing or writing a file', async () => {
    const fake = fakeBrowser();
    const before = readManifest(runDir);

    const result = await call({ page_id: 'page-7' }, fake.browser);

    expect(result.isError).toBe(false);
    if (result.isError || result.image === undefined) throw new Error('expected inline image');
    expect(result.content).toContain('https://sheets.example.test/edit#gid=0');
    expect(result.content).toContain('"width":1');
    expect(result.image.source.media_type).toBe('image/png');
    expect(Buffer.from(result.image.source.data, 'base64')).toEqual(ONE_PIXEL_PNG);
    expect(result.imageBytes).toBe(ONE_PIXEL_PNG.byteLength);
    expect(fake.currentUrl).toHaveBeenCalledWith('page-7');
    expect(fake.screenshot).toHaveBeenCalledWith({
      pageId: 'page-7',
      fullPage: false,
      scale: 'css',
    });
    expect(readManifest(runDir)).toEqual(before);
  });

  it('fails clearly without a browser or with non-image provider bytes', async () => {
    const missing = await call({});
    expect(missing).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(missing.content).toContain('requires an active browser session');

    const invalid = await call({}, fakeBrowser(Buffer.from('not png')).browser);
    expect(invalid).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(invalid.content).toContain('not a readable image/png image');
  });

  it('rejects unknown input fields before touching the browser', async () => {
    const fake = fakeBrowser();
    const result = await call({ full_page: true }, fake.browser);
    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(fake.screenshot).not.toHaveBeenCalled();
  });
});
