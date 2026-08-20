import { describe, expect, it } from 'vitest';

import { readManifest } from '../../../src/run/artifacts.js';
import {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  captureScreenshotTool,
} from '../../../src/tools/captureScreenshot/captureScreenshot.js';
import {
  createBrowserExecuteTool,
  type BrowserExecuteResult,
} from '../../../src/tools/browserExecute/browserExecute.js';
import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry } from '../../../src/tools/registry.js';
import { BROWSER_TEST_TIMEOUT_MS, setupBrowserToolSuite } from '../../helpers/browserToolSuite.js';

describe('capture_screenshot real-browser journey', () => {
  const suite = setupBrowserToolSuite('capture-screenshot');
  const registry = createRegistry([
    createBrowserExecuteTool({ javascriptPolicy: 'allow', secretEnvDenylist: [] }),
    captureScreenshotTool,
  ]);

  it(
    'returns the exact live viewport as inline PNG pixels without publishing it',
    async () => {
      const pageUrl = suite.server().url('/index.html');
      const context = { runDir: suite.runDir(), browser: suite.controller() };
      const navigated = await executeToolCall(
        registry,
        {
          id: 'navigate-before-capture',
          name: 'browser_execute',
          input: { code: `await browser.goto(${JSON.stringify(pageUrl)});` },
        },
        context,
      );
      expect(navigated.isError, navigated.content).toBe(false);
      expect((JSON.parse(navigated.content) as BrowserExecuteResult).pages).toEqual([
        expect.objectContaining({ url: pageUrl, active: true }),
      ]);

      const captured = await executeToolCall(
        registry,
        { id: 'capture-live-viewport', name: CAPTURE_SCREENSHOT_TOOL_NAME, input: {} },
        context,
      );

      expect(captured.isError, captured.content).toBe(false);
      if (captured.isError || captured.image === undefined) {
        throw new Error('expected an inline screenshot');
      }
      const bytes = Buffer.from(captured.image.source.data, 'base64');
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(captured.content).toContain(pageUrl);
      expect(captured.content).toMatch(/"width":\d+/);
      expect(captured.content).toMatch(/"height":\d+/);
      expect(readManifest(suite.runDir()).artifacts).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
