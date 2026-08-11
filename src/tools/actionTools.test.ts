import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BrowserAdapter } from '../browser/adapter.js';
import { launchPersistentChrome } from '../browser/playwrightAdapter.js';
import { initManifest } from '../run/artifacts.js';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server.js';
import { actionTools, scrollTool } from './actionTools.js';
import { observationTools } from './observationTools.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry } from './registry.js';

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

describe('browser action tools', () => {
  let adapter: BrowserAdapter;
  let fixtureServer: FixtureServer;
  let profileDir: string;
  let runDir: string;

  const registry = createRegistry([...observationTools, ...actionTools]);

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), 'action-tools-chrome-'));
    adapter = await launchPersistentChrome({ profileDir, headless: true });
  }, 30_000);

  beforeEach(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'action-tools-run-'));
    initManifest(runDir, 'test browser action tools');
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
    'types and clicks by ref, with effects visible through a fresh inspection',
    async () => {
      await call('navigate', { url: fixtureServer.url('/') });
      const before = await call('inspect_page', {});
      expect(before.isError).toBe(false);
      const inputRef = refFor(before.content, 'textbox "Evidence query"');
      const buttonRef = refFor(before.content, 'button "Announce ready"');
      const linkRef = refFor(before.content, 'link "Visit second page"');

      const typed = await call('type', {
        ref: inputRef,
        text: 'quarterly controls',
      });
      const clicked = await call('click', { ref: buttonRef });
      expect(typed).toMatchObject({ isError: false });
      expect(typed.content).toContain(`ref=${inputRef}`);
      expect(typed.content).toContain('textbox "Evidence query"');
      expect(clicked).toMatchObject({ isError: false });
      expect(clicked.content).toContain(`ref=${buttonRef}`);
      expect(clicked.content).toContain('button "Announce ready"');

      const after = await call('inspect_page', {});
      expect(after.isError).toBe(false);
      expect(after.content).toContain('quarterly controls');
      expect(after.content).toContain('Ready');

      // The semantic confirmation is captured before the click, so it still
      // names a link that disappears when its click navigates away.
      const navigated = await call('click', { ref: linkRef });
      expect(navigated).toMatchObject({ isError: false });
      expect(navigated.content).toContain('link "Visit second page"');
      const destination = await call('inspect_page', {});
      expect(destination.content).toContain('Second fixture page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'turns a stale ref into a structured error directing a fresh inspection',
    async () => {
      await call('navigate', { url: fixtureServer.url('/') });
      const inspected = await call('inspect_page', {});
      const staleRef = refFor(inspected.content, 'button "Announce ready"');
      await call('navigate', { url: fixtureServer.url('/second.html') });

      const result = await call('click', { ref: staleRef });

      expect(result).toMatchObject({
        isError: true,
        errorKind: 'execution_error',
      });
      expect(result.content).toContain(staleRef);
      expect(result.content).toContain('inspect_page');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'scrolls one viewport so a fresh inspection sees lazy-loaded content',
    async () => {
      await call('navigate', { url: fixtureServer.url('/lazy-load.html') });
      const before = await call('inspect_page', {});
      expect(before.isError).toBe(false);
      expect(before.content).not.toContain('Lazy evidence item 20');

      const scrolled = await call('scroll', {});
      expect(scrolled).toMatchObject({ isError: false });
      expect(scrollTool.readOnly).toBe(false);

      const after = await call('inspect_page', {});
      expect(after.isError).toBe(false);
      expect(after.content).toContain('Lazy evidence item 20');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
