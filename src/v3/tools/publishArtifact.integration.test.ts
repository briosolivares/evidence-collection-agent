import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../../tools/pipeline.js';
import { createRegistry } from '../../tools/registry.js';
import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import {
  createBrowserExecuteTool,
  type BrowserExecuteResult,
} from './browserExecute.js';
import { publishArtifactTool } from './publishArtifact.js';

describe('publish_artifact real-browser download journey', () => {
  const suite = setupBrowserToolSuite('v3-publish-artifact');
  const browserExecuteTool = createBrowserExecuteTool({
    javascriptPolicy: 'allow',
    secretEnvDenylist: [],
  });
  const registry = createRegistry([browserExecuteTool, publishArtifactTool]);

  it(
    'publishes exact blob-download bytes from an accessibility backend node',
    async () => {
      const rootUrl = suite.server().url('/');
      const downloadsUrl = suite.server().url('/downloads.html');
      const context = {
        runDir: suite.runDir(),
        browser: suite.controller(),
      };

      const inspected = await executeToolCall(
        registry,
        {
          id: 'inspect-download',
          name: 'browser_execute',
          input: {
            code: `
              await browser.goto(${JSON.stringify(rootUrl)});
              await browser.goto(${JSON.stringify(downloadsUrl)});
              const tree = await browser.accessibility({
                roles: ['button'],
                name: 'Generate download with JavaScript',
                maxDepth: 20,
                maxNodes: 20
              });
              const target = tree.nodes.find((node) =>
                node.role === 'button' &&
                node.name === 'Generate download with JavaScript'
              );
              if (!target?.backendDOMNodeId) {
                throw new Error('download control had no backend DOM node id');
              }
              return { backendNodeId: target.backendDOMNodeId };
            `,
          },
        },
        context,
      );
      expect(inspected.isError, inspected.content).toBe(false);
      const inspectedResult = JSON.parse(inspected.content) as BrowserExecuteResult;
      const backendNodeId = (inspectedResult.value as { backendNodeId: number })
        .backendNodeId;

      const published = await executeToolCall(
        registry,
        {
          id: 'publish-download',
          name: 'publish_artifact',
          input: {
            kind: 'download',
            artifact_path: 'artifacts/browser-evidence.bin',
            roles: ['requested_output', 'evidence'],
            backend_node_id: backendNodeId,
          },
        },
        context,
      );
      expect(published.isError, published.content).toBe(false);

      const expected = Buffer.from('browser-native-download\n');
      expect(
        readFileSync(join(suite.runDir(), 'artifacts/browser-evidence.bin')),
      ).toEqual(expected);
      expect(readManifest(suite.runDir()).artifacts).toEqual([
        expect.objectContaining({
          filename: 'artifacts/browser-evidence.bin',
          sha256: createHash('sha256').update(expected).digest('hex'),
          sourceUrl: downloadsUrl,
          roles: ['requested_output', 'evidence'],
        }),
      ]);

      const checked = await executeToolCall(
        registry,
        {
          id: 'check-marker-cleanup',
          name: 'browser_execute',
          input: {
            code:
              `return browser.js("document.querySelectorAll('[data-sherlock-backend-target]').length");`,
          },
        },
        context,
      );
      expect(checked.isError, checked.content).toBe(false);
      expect((JSON.parse(checked.content) as BrowserExecuteResult).value).toBe(0);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
