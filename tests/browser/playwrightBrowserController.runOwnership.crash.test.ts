import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';

import { AttachedChromeBrowserSessionProvider } from '../../src/browser/attachedChromeBrowserSessionProvider.js';
import { launchPersistentChrome } from '../../src/browser/playwrightBrowserController.js';
import { createBusyResourceRegistry } from '../../src/tools/registry.js';

interface RunningFixture {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

interface FixtureMessage {
  type?: string;
  message?: string;
  pageCount?: number;
  processId?: number;
}

const FIXTURE = fileURLToPath(
  new URL('../fixtures/browserPageOwnershipCrashChild.ts', import.meta.url),
);
const processDescribe = process.platform === 'win32' ? describe.skip : describe;

processDescribe('durable browser page ownership after process death', () => {
  it('reclaims a SIGKILLed run through a fresh attached client and preserves user tabs', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'browser-owner-crash-'));
    let context: BrowserContext | undefined;
    let fixture: RunningFixture | undefined;
    try {
      context = await launchPersistentChrome({ profileDir, headless: true });
      const firstUserPage = context.pages()[0] ?? (await context.newPage());
      const secondUserPage = await context.newPage();
      await Promise.all([
        firstUserPage.goto('data:text/html,<title>user-one</title>'),
        secondUserPage.goto('data:text/html,<title>user-two</title>'),
      ]);
      const userPages = [firstUserPage, secondUserPage];
      const endpoint = await attachedEndpoint(profileDir);
      const ownershipId = 'real-sigkill-page-owner';

      fixture = startFixture(endpoint, ownershipId);
      const ready = await waitForMessage(fixture, (message) => message.type === 'ready');
      expect(ready.pageCount).toBe(2);
      const nonUserPages = context.pages().filter((page) => !userPages.includes(page));
      const titledNonUserPages = await Promise.all(
        nonUserPages.map(async (page) => ({ page, title: await page.title() })),
      );
      const stalePages = titledNonUserPages
        .filter(({ title }) => title === 'crash-main' || title === 'crash-popup')
        .map(({ page }) => page);
      expect(nonUserPages).toHaveLength(2);
      expect(stalePages).toHaveLength(2);

      fixture.child.kill('SIGKILL');
      const exit = await waitForExit(fixture);
      expect(exit.signal).toBe('SIGKILL');
      fixture = undefined;
      for (const page of [...userPages, ...stalePages]) {
        expect(page.isClosed()).toBe(false);
      }

      const wrongRun = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: endpoint,
      }).createSession();
      await wrongRun.initializeRunPageOwnership?.('different-run');
      await wrongRun.close();
      for (const page of stalePages) expect(page.isClosed()).toBe(false);

      const resumed = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: endpoint,
      }).createSession();
      resumed.setBusyRegistry?.(createBusyResourceRegistry());
      await resumed.initializeRunPageOwnership?.(ownershipId);
      await resumed.initializeRunPageOwnership?.(ownershipId);
      for (const page of stalePages) expect(page.isClosed()).toBe(true);
      for (const page of userPages) expect(page.isClosed()).toBe(false);

      if (resumed.prepareTaskPage === undefined) {
        throw new Error('Attached controller omitted task-page preparation.');
      }
      await resumed.prepareTaskPage({ ownershipId });
      expect(await resumed.pages()).toHaveLength(1);
      await resumed.closeTaskPages();
      await resumed.closeTaskPages();
      for (const page of userPages) expect(page.isClosed()).toBe(false);
      await resumed.close();
    } finally {
      if (
        fixture !== undefined &&
        fixture.child.exitCode === null &&
        fixture.child.signalCode === null
      ) {
        fixture.child.kill('SIGKILL');
        await waitForExit(fixture).catch(() => undefined);
      }
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('reclaims a target committed before its page marker after SIGKILL', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'browser-sentinel-crash-'));
    let context: BrowserContext | undefined;
    let fixture: RunningFixture | undefined;
    try {
      context = await launchPersistentChrome({ profileDir, headless: true });
      const firstUserPage = context.pages()[0] ?? (await context.newPage());
      const secondUserPage = await context.newPage();
      await Promise.all([
        firstUserPage.goto('data:text/html,<title>sentinel-user-one</title>'),
        secondUserPage.goto('data:text/html,<title>sentinel-user-two</title>'),
      ]);
      const userPages = [firstUserPage, secondUserPage];
      const endpoint = await attachedEndpoint(profileDir);
      const ownershipId = 'real-sigkill-target-sentinel';

      fixture = startFixture(endpoint, ownershipId, 'committed-sentinel');
      await waitForMessage(fixture, (message) => message.type === 'sentinel_committed');
      const [sentinelPage] = await waitForNonUserPages(context, userPages, 1);
      expect(sentinelPage).toBeDefined();
      expect(sentinelPage!.url()).toMatch(
        /^about:blank#__sherlock_run_target_v1__:[A-Za-z0-9_-]{43}$/u,
      );
      expect(sentinelPage!.url()).not.toContain(ownershipId);
      expect(
        await sentinelPage!.evaluate(
          (property) => Object.hasOwn(window, property),
          '__sherlock_run_page_owner_v1__',
        ),
      ).toBe(false);

      fixture.child.kill('SIGKILL');
      const exit = await waitForExit(fixture);
      expect(exit.signal).toBe('SIGKILL');
      fixture = undefined;
      expect(sentinelPage!.isClosed()).toBe(false);

      const wrongRun = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: endpoint,
      }).createSession();
      await wrongRun.initializeRunPageOwnership?.('different-sentinel-run');
      expect(sentinelPage!.isClosed()).toBe(false);
      await wrongRun.close();

      const resumed = await new AttachedChromeBrowserSessionProvider({
        cdpEndpoint: endpoint,
      }).createSession();
      await resumed.initializeRunPageOwnership?.(ownershipId);
      expect(sentinelPage!.isClosed()).toBe(true);
      for (const page of userPages) expect(page.isClosed()).toBe(false);
      await resumed.closeTaskPages();
      await resumed.close();
    } finally {
      if (
        fixture !== undefined &&
        fixture.child.exitCode === null &&
        fixture.child.signalCode === null
      ) {
        fixture.child.kill('SIGKILL');
        await waitForExit(fixture).catch(() => undefined);
      }
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function startFixture(
  endpoint: string,
  ownershipId: string,
  mode: 'marked-pages' | 'committed-sentinel' = 'marked-pages',
): RunningFixture {
  const child = fork(FIXTURE, [endpoint, ownershipId, mode], {
    cwd: process.cwd(),
    execArgv: ['--import', 'tsx'],
    silent: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const running: RunningFixture = { child, stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk: Buffer | string) => {
    running.stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    running.stderr += chunk.toString();
  });
  return running;
}

async function waitForNonUserPages(
  context: BrowserContext,
  userPages: readonly ReturnType<BrowserContext['pages']>[number][],
  count: number,
): Promise<ReturnType<BrowserContext['pages']>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pages = context.pages().filter((page) => !userPages.includes(page));
    if (pages.length === count) return pages;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} non-user page(s); saw ${pages.length}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForMessage(
  running: RunningFixture,
  predicate: (message: FixtureMessage) => boolean,
): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for fixture IPC.${diagnostic(running)}`));
    }, 10_000);
    const onMessage = (message: FixtureMessage): void => {
      if (message.type === 'error') {
        cleanup();
        reject(new Error(`Fixture failed: ${message.message ?? 'unknown error'}`));
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Fixture exited before expected IPC (code=${String(code)}, ` +
            `signal=${String(signal)}).${diagnostic(running)}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off('message', onMessage);
      running.child.off('exit', onExit);
    };
    running.child.on('message', onMessage);
    running.child.once('exit', onExit);
  });
}

function waitForExit(
  running: RunningFixture,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    return Promise.resolve({
      code: running.child.exitCode,
      signal: running.child.signalCode,
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for fixture exit.${diagnostic(running)}`));
    }, 10_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      running.child.off('exit', onExit);
    };
    running.child.once('exit', onExit);
  });
}

async function attachedEndpoint(profileDir: string): Promise<string> {
  const port = Number(
    (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]?.trim(),
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Chrome did not publish a usable loopback DevTools port.');
  }
  return `http://127.0.0.1:${port}`;
}

function diagnostic(running: RunningFixture): string {
  return `\nstdout:\n${running.stdout || '(empty)'}\nstderr:\n${running.stderr || '(empty)'}`;
}
