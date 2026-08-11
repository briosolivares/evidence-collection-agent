import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
import { initManifest } from '../run/artifacts.js';
import { type OffloadedResult } from './capResult.js';
import {
  inspectPageTool,
  navigateTool,
  observationTools,
} from './observationTools.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry } from './registry.js';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import type { BrowserAdapter } from '../browser/adapter.js';

const BROWSER_TEST_TIMEOUT_MS = 15_000;

function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(
    new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`),
  );

  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName} in:\n${outline}`);
  }
  return match[1];
}

describe('browser observation tools', () => {
  let adapter: BrowserAdapter;
  let fixtureServer: FixtureServer;
  let profileDir: string;
  let runDir: string;

  const registry = createRegistry(observationTools);

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), 'observe-tools-chrome-'));
    adapter = await launchPersistentChrome({ profileDir, headless: true });
  }, 30_000);

  beforeEach(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'observe-tools-run-'));
    initManifest(runDir, 'test browser observation tools');
    await adapter.newTab();
  });

  afterEach(async () => {
    await adapter.closeTab();
    rmSync(runDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await adapter?.close();
    await fixtureServer?.close();
    if (profileDir !== undefined) {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir, browser: adapter },
    );
  }

  it(
    'navigate reports the landed URL and title after a redirect',
    async () => {
      const result = await call('navigate', {
        url: fixtureServer.url('/redirect-to-second'),
      });

      expect(result).toEqual({
        toolCallId: 'call-navigate',
        isError: false,
        content: `URL: ${fixtureServer.url('/second.html')}\nTitle: Second Fixture Page`,
      });
      expect(navigateTool.readOnly).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'inspect_page returns full-page interactive semantics and stable refs',
    async () => {
      await call('navigate', { url: fixtureServer.url('/') });

      const first = await call('inspect_page', {});
      const second = await call('inspect_page', {});

      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(first.content).toContain(
        `URL: ${fixtureServer.url('/')}\nTitle: Browser Adapter Fixture\n\n`,
      );
      for (const roleAndName of [
        'link "Visit second page"',
        'button "Announce ready"',
        'textbox "Evidence query"',
        'button "Collect below-fold evidence"',
      ]) {
        expect(refFor(first.content, roleAndName)).toBe(
          refFor(second.content, roleAndName),
        );
      }
      expect(inspectPageTool.readOnly).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'offloads an oversized outline with a preview and complete file',
    async () => {
      await call('navigate', { url: fixtureServer.url('/oversized.html') });
      const uncapped = await call('inspect_page', {});
      expect(uncapped.isError).toBe(false);
      const smallCapRegistry = createRegistry([
        { ...inspectPageTool, maxBytes: 400 },
      ]);

      const result = await executeToolCall(
        smallCapRegistry,
        { id: 'call-oversized', name: 'inspect_page', input: {} },
        { runDir, browser: adapter },
      );

      expect(result.isError).toBe(false);
      const replacement = JSON.parse(result.content) as OffloadedResult;
      expect(replacement.preview).toContain('Oversized Outline Fixture');
      expect(replacement.offloadedTo).toMatch(/^tool-output\/inspect_page-/);
      const fullOutline = readFileSync(join(runDir, replacement.offloadedTo), 'utf8');
      expect(fullOutline).toBe(uncapped.content);
      expect(fullOutline).toContain('link "Evidence record 120"');
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
