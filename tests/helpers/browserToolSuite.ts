import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import type { BrowserController } from '../../src/browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import { initManifest } from '../../src/run/artifacts.js';
import { createBusyResourceRegistry } from '../../src/tools/registry.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/** Timeout for individual tests that drive the real browser. */
export const BROWSER_TEST_TIMEOUT_MS = 15_000;

/** Accessors into the suite's live browser state; each is valid once the
 * corresponding lifecycle hook has run (i.e. inside tests). */
export interface BrowserToolSuite {
  /** The suite's live browser controller (one headless Chrome per suite). */
  controller: () => BrowserController;
  /** The suite's loopback fixture server. */
  server: () => FixtureServer;
  /** The current test's run directory — fresh per test, manifest initialized. */
  runDir: () => string;
}

/**
 * Register the shared lifecycle every browser tool suite needs: one
 * headless Chrome (temp profile) and one fixture server per suite, plus a
 * fresh run directory (manifest initialized) and browser tab per test.
 * Call once inside a `describe` block; `name` prefixes the temp dirs so a
 * leftover is attributable to its suite.
 */
export function setupBrowserToolSuite(name: string): BrowserToolSuite {
  let controller: BrowserController;
  let fixtureServer: FixtureServer;
  let profileDir: string;
  let runDir: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    profileDir = await mkdtemp(join(tmpdir(), `${name}-chrome-`));
    const browserSessionProvider = new LocalChromeBrowserSessionProvider({
      profileDir,
      headless: true,
    });
    controller = await browserSessionProvider.createSession();
    controller.setBusyRegistry?.(createBusyResourceRegistry());
  }, 30_000);

  beforeEach(async () => {
    runDir = mkdtempSync(join(tmpdir(), `${name}-run-`));
    initManifest(runDir, `test ${name}`);
    if (controller.prepareTaskPage === undefined) {
      throw new Error('Browser test controller lacks v3 task-page preparation');
    }
    await controller.prepareTaskPage({ ownershipId: runDir });
  });

  afterEach(async () => {
    await controller.closeTaskPages();
    rmSync(runDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await controller?.close();
    await fixtureServer?.close();
    if (profileDir !== undefined) {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  return {
    controller: () => controller,
    server: () => fixtureServer,
    runDir: () => runDir,
  };
}
