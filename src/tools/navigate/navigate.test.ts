import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { navigateTool } from './navigate.js';

describe('navigate tool', () => {
  const suite = setupBrowserToolSuite('navigate-tool');
  const registry = createRegistry([navigateTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.adapter() },
    );
  }

  it(
    'reports the landed URL and title after a redirect',
    async () => {
      const result = await call('navigate', {
        url: suite.server().url('/redirect-to-second'),
      });

      expect(result).toEqual({
        toolCallId: 'call-navigate',
        isError: false,
        content: `URL: ${suite.server().url('/second.html')}\nTitle: Second Fixture Page`,
      });
      expect(navigateTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'returns a structured error when navigation cannot reach the URL',
    async () => {
      const unreachableUrl = await closedLoopbackUrl();
      const result = await call('navigate', { url: unreachableUrl });

      expect(result).toMatchObject({
        toolCallId: 'call-navigate',
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain('navigate');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});

async function closedLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Temporary server did not bind to an IP port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}/unreachable`;
}
