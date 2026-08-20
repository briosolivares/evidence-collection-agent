import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executeToolCall } from '../../../src/tools/pipeline.js';
import { createRegistry } from '../../../src/tools/registry.js';
import { BROWSER_TEST_TIMEOUT_MS, setupBrowserToolSuite } from '../../helpers/browserToolSuite.js';
import {
  createBrowserExecuteTool,
  type BrowserExecuteResult,
} from '../../../src/tools/browserExecute/browserExecute.js';

describe('browser_execute real-browser journey', () => {
  const suite = setupBrowserToolSuite('browser-execute');

  it(
    'navigates, inspects AX, interacts, extracts, writes scratch, opens a page, and cleans up',
    async () => {
      const startUrl = suite.server().url('/index.html');
      const popupUrl = suite.server().url('/popup.html');
      const code = `
        await browser.goto(${JSON.stringify(startUrl)});
        if (!(await browser.waitForLoad({ timeoutMs: 5000, pollIntervalMs: 25 }))) {
          throw new Error('fixture did not finish loading');
        }

        const tree = await browser.accessibility({
          roles: ['button', 'textbox'],
          maxDepth: 20,
          maxNodes: 50
        });
        const button = tree.nodes.find((node) =>
          node.role === 'button' && node.name === 'Announce ready'
        );
        const textbox = tree.nodes.find((node) =>
          node.role === 'textbox' && node.name === 'Evidence query'
        );
        if (!button?.backendDOMNodeId || !textbox?.backendDOMNodeId) {
          throw new Error('expected AX controls were absent');
        }

        async function center(backendNodeId) {
          const response = await browser.cdp('DOM.getBoxModel', { backendNodeId });
          const quad = response.model?.content;
          if (!Array.isArray(quad) || quad.length !== 8) {
            throw new Error('control had no content box');
          }
          return {
            x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
            y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
          };
        }

        const buttonPoint = await center(button.backendDOMNodeId);
        await browser.click(buttonPoint.x, buttonPoint.y);
        if (!(await browser.waitFor(
          'document.querySelector("#status")?.textContent === "Ready"',
          { timeoutMs: 3000, pollIntervalMs: 25 }
        ))) {
          throw new Error('button click did not reach its postcondition');
        }

        const textboxPoint = await center(textbox.backendDOMNodeId);
        await browser.click(textboxPoint.x, textboxPoint.y);
        await browser.type('audit evidence');
        const extracted = await browser.js(
          '({ status: document.querySelector("#status")?.textContent, ' +
          'query: document.querySelector("#evidence-query")?.value })'
        );

        const { writeFile } = await import('node:fs/promises');
        await writeFile('journey.json', JSON.stringify(extracted));
        const popup = await browser.open(${JSON.stringify(popupUrl)});
        return { info: await browser.pageInfo(), extracted, popup, axNodes: tree.nodes.length };
      `;
      const tool = createBrowserExecuteTool({
        javascriptPolicy: 'allow',
        secretEnvDenylist: [],
      });
      const result = await executeToolCall(
        createRegistry([tool]),
        { id: 'real-browser-program', name: 'browser_execute', input: { code } },
        { runDir: suite.runDir(), browser: suite.controller() },
      );

      expect(result.isError, result.content).toBe(false);
      const parsed = JSON.parse(result.content) as BrowserExecuteResult;
      expect(parsed.status).toBe('exited');
      expect(parsed.value).toMatchObject({
        extracted: { status: 'Ready', query: 'audit evidence' },
        popup: { url: popupUrl },
      });
      expect((parsed.value as { axNodes: number }).axNodes).toBeGreaterThanOrEqual(2);
      expect(parsed.changed_files).toEqual([
        { path: 'scratch/workspace/journey.json', change: 'created' },
      ]);
      expect(parsed.pages.map((page) => page.url).sort()).toEqual([startUrl, popupUrl].sort());
      expect(parsed.pending_dialogs).toEqual([]);

      await suite.controller().closeTaskPages();
      expect(await suite.controller().pages()).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a blocking native dialog and handles it explicitly on the next call',
    async () => {
      const tool = createBrowserExecuteTool({
        javascriptPolicy: 'allow',
        secretEnvDenylist: [],
      });
      const registry = createRegistry([tool]);
      const context = {
        runDir: suite.runDir(),
        browser: suite.controller(),
      };

      const blocked = await executeToolCall(
        registry,
        {
          id: 'open-dialog',
          name: 'browser_execute',
          input: {
            code: `return browser.js("alert('Need an explicit decision')");`,
            timeout_ms: 250,
          },
        },
        context,
      );
      expect(blocked.isError, blocked.content).toBe(false);
      const blockedResult = JSON.parse(blocked.content) as BrowserExecuteResult;
      expect(blockedResult.status).toBe('timed_out');
      expect(blockedResult.pending_dialogs).toEqual([
        expect.objectContaining({
          pageId: expect.any(String),
          type: 'alert',
          message: 'Need an explicit decision',
        }),
      ]);

      const handled = await executeToolCall(
        registry,
        {
          id: 'dismiss-dialog',
          name: 'browser_execute',
          input: {
            code:
              `await browser.handleDialog('dismiss'); ` +
              `return browser.js('document.readyState');`,
          },
        },
        context,
      );
      expect(handled.isError, handled.content).toBe(false);
      const handledResult = JSON.parse(handled.content) as BrowserExecuteResult;
      expect(handledResult.status, JSON.stringify(handledResult)).toBe('exited');
      expect(handledResult).toMatchObject({
        value: 'complete',
        pending_dialogs: [],
      });
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'retires a renderer wedged by a timed-out command and runs the next program',
    async () => {
      const tool = createBrowserExecuteTool({
        javascriptPolicy: 'allow',
        secretEnvDenylist: [],
      });
      const registry = createRegistry([tool]);
      const context = {
        runDir: suite.runDir(),
        browser: suite.controller(),
      };
      const originalPageId = (await suite.controller().pages())[0]?.pageId;
      expect(originalPageId).toBeDefined();

      const timedOut = await executeToolCall(
        registry,
        {
          id: 'wedge-renderer',
          name: 'browser_execute',
          input: {
            code:
              `return browser.cdp('Runtime.evaluate', { ` +
              `expression: 'while (true) {}', returnByValue: true });`,
            timeout_ms: 250,
          },
        },
        context,
      );

      expect(timedOut.isError, timedOut.content).toBe(false);
      const timedOutResult = JSON.parse(timedOut.content) as BrowserExecuteResult;
      expect(timedOutResult.status).toBe('timed_out');
      expect(timedOutResult.pages).toEqual([
        expect.objectContaining({ active: true, url: 'about:blank' }),
      ]);
      expect(timedOutResult.pages[0]?.pageId).not.toBe(originalPageId);

      const recovered = await executeToolCall(
        registry,
        {
          id: 'use-replacement',
          name: 'browser_execute',
          input: { code: `return browser.js('40 + 2');` },
        },
        context,
      );

      expect(recovered.isError, recovered.content).toBe(false);
      expect(JSON.parse(recovered.content)).toMatchObject({
        status: 'exited',
        value: 42,
        pending_dialogs: [],
      });
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'uploads a confined workspace file to an accessibility backend node and removes its marker',
    async () => {
      const workspace = join(suite.runDir(), 'scratch/workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'evidence.csv'), 'name\nAda Lovelace\n');
      writeFileSync(
        join(workspace, 'upload-helper.mjs'),
        `export const uploadPath = 'evidence.csv';\n`,
      );
      const actionsUrl = suite.server().url('/actions.html');
      const code = `
        const helper = await browser.importModule('./upload-helper.mjs');
        await browser.goto(${JSON.stringify(actionsUrl)});
        if (!(await browser.waitForLoad({ timeoutMs: 5000, pollIntervalMs: 25 }))) {
          throw new Error('upload fixture did not finish loading');
        }
        const tree = await browser.accessibility({
          name: 'Attachment file',
          maxDepth: 30,
          maxNodes: 20
        });
        const input = tree.nodes.find((node) =>
          node.name === 'Attachment file' && node.backendDOMNodeId
        );
        if (!input?.backendDOMNodeId) {
          throw new Error('file input backend node was absent');
        }
        await browser.upload(input.backendDOMNodeId, helper.uploadPath);
        return browser.js(\`(async () => {
          const element = document.querySelector('#attachment-input');
          const file = element?.files?.[0];
          return {
            name: file?.name ?? null,
            text: file ? await file.text() : null,
            visible: document.querySelector('#attachment')?.textContent ?? null,
            markerCount: document.querySelectorAll('[data-sherlock-backend-target]').length
          };
        })()\`);
      `;
      const tool = createBrowserExecuteTool({
        javascriptPolicy: 'allow',
        secretEnvDenylist: [],
      });
      const result = await executeToolCall(
        createRegistry([tool]),
        { id: 'real-browser-upload', name: 'browser_execute', input: { code } },
        { runDir: suite.runDir(), browser: suite.controller() },
      );

      expect(result.isError, result.content).toBe(false);
      const parsed = JSON.parse(result.content) as BrowserExecuteResult;
      expect(parsed).toMatchObject({
        status: 'exited',
        value: {
          name: 'evidence.csv',
          text: 'name\nAda Lovelace\n',
          visible: 'Attachment: evidence.csv',
          markerCount: 0,
        },
        changed_files: [
          { path: 'scratch/workspace/evidence.csv', change: 'created' },
          { path: 'scratch/workspace/upload-helper.mjs', change: 'created' },
        ],
      });
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
