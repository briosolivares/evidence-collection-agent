import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';

import { createChromiumTargetControl } from '../../browser/chromiumTargetControl.js';
import type { BrowserController } from '../../browser/controller.js';
import {
  launchPersistentChrome,
  PlaywrightBrowserController,
} from '../../browser/playwrightBrowserController.js';
import { initManifest, readManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../../tools/pipeline.js';
import {
  createBusyResourceRegistry,
  createRegistry,
} from '../../tools/registry.js';
import {
  startFixtureServer,
  type FixtureServer,
} from '../../../tests/fixtures/server.js';
import {
  createBrowserExecuteTool,
  type BrowserExecuteResult,
} from './browserExecute.js';
import { publishArtifactTool } from './publishArtifact.js';

const TEST_TIMEOUT_MS = 45_000;
const HELPER_FIXTURE = fileURLToPath(
  new URL('../../../tests/fixtures/multiPageSynthesisHelper.mjs', import.meta.url),
);

interface PageFact {
  label: string;
  title: string;
  heading: string;
  url: string;
}

describe('Sherlock v3 multi-page synthesis acceptance', () => {
  it(
    'synthesizes two owned pages through a run-local helper and preserves a user page',
    async () => {
      const profileDir = await mkdtemp(join(tmpdir(), 'v3-multi-page-chrome-'));
      const runDir = await mkdtemp(join(tmpdir(), 'v3-multi-page-run-'));
      let fixtureServer: FixtureServer | undefined;
      let context: BrowserContext | undefined;
      let controller: BrowserController | undefined;

      try {
        fixtureServer = await startFixtureServer();
        initManifest(runDir, 'Synthesize facts from two browser pages', 'local');
        const workspace = join(runDir, 'scratch/workspace');
        mkdirSync(workspace, { recursive: true });
        copyFileSync(HELPER_FIXTURE, join(workspace, 'synthesis-helper.mjs'));

        context = await launchPersistentChrome({ profileDir, headless: true });
        const anchorPage = context.pages()[0] ?? (await context.newPage());
        const userPage = await context.newPage();
        await userPage.goto(
          `data:text/html,${encodeURIComponent(
            '<title>User workspace</title><h1 id="user-marker">Leave me open</h1>',
          )}`,
        );
        const preexistingPages = [...context.pages()];
        const targetControl = await createChromiumTargetControl({
          context,
          anchorPage,
        });
        controller = new PlaywrightBrowserController({
          context,
          preexistingSessionPages: preexistingPages,
          targetControl,
        });
        controller.setBusyRegistry?.(createBusyResourceRegistry());
        expect(await controller.pages()).toEqual([]);

        if (controller.prepareTaskPage === undefined) {
          throw new Error('Browser controller omitted v3 task-page preparation.');
        }
        const mainUrl = fixtureServer.url('/index.html');
        const popupUrl = fixtureServer.url('/popup.html');
        await controller.prepareTaskPage({
          ownershipId: 'v3-multi-page-synthesis-acceptance',
          startUrl: mainUrl,
        });

        const browserExecuteTool = createBrowserExecuteTool({
          javascriptPolicy: 'allow',
          secretEnvDenylist: [],
        });
        const registry = createRegistry([
          browserExecuteTool,
          publishArtifactTool,
        ]);
        const toolContext = { runDir, browser: controller };

        const mainExecution = await executeToolCall(
          registry,
          {
            id: 'extract-main-and-open-second-page',
            name: 'browser_execute',
            input: {
              code: `
                const helper = await browser.importModule('./synthesis-helper.mjs');
                if (!(await browser.waitForLoad({ timeoutMs: 5000, pollIntervalMs: 25 }))) {
                  throw new Error('main fixture did not finish loading');
                }
                const fact = await helper.capturePage(browser, 'Main page');
                const secondPage = await browser.open('about:blank');
                return { fact, secondPage };
              `,
            },
          },
          toolContext,
        );
        expect(mainExecution.isError, mainExecution.content).toBe(false);
        const mainResult = JSON.parse(
          mainExecution.content,
        ) as BrowserExecuteResult;
        expect(mainResult).toMatchObject({
          status: 'exited',
          value: {
            fact: {
              label: 'Main page',
              title: 'Browser Controller Fixture',
              heading: 'Browser controller fixture',
              url: mainUrl,
            },
          },
        });
        expect(mainResult.pages).toHaveLength(2);
        const secondPage = mainResult.pages.find((page) => !page.active);
        expect(secondPage).toBeDefined();

        const secondExecution = await executeToolCall(
          registry,
          {
            id: 'extract-second-page',
            name: 'browser_execute',
            input: {
              page_id: secondPage!.pageId,
              code: `
                const helper = await browser.importModule('./synthesis-helper.mjs');
                await browser.goto(${JSON.stringify(popupUrl)});
                if (!(await browser.waitForLoad({ timeoutMs: 5000, pollIntervalMs: 25 }))) {
                  throw new Error('second fixture did not finish loading');
                }
                return helper.capturePage(browser, 'Popup page');
              `,
            },
          },
          toolContext,
        );
        expect(secondExecution.isError, secondExecution.content).toBe(false);
        const secondResult = JSON.parse(
          secondExecution.content,
        ) as BrowserExecuteResult;
        expect(secondResult).toMatchObject({
          status: 'exited',
          value: {
            label: 'Popup page',
            title: 'Popup Fixture',
            heading: 'Popup fixture',
            url: popupUrl,
          },
        });
        expect(secondResult.pages.map((page) => page.url).sort()).toEqual(
          [mainUrl, popupUrl].sort(),
        );

        const expectedFacts: PageFact[] = [
          {
            label: 'Main page',
            title: 'Browser Controller Fixture',
            heading: 'Browser controller fixture',
            url: mainUrl,
          },
          {
            label: 'Popup page',
            title: 'Popup Fixture',
            heading: 'Popup fixture',
            url: popupUrl,
          },
        ];
        expect(
          JSON.parse(
            readFileSync(join(workspace, 'synthesis-facts.json'), 'utf8'),
          ),
        ).toEqual(expectedFacts);

        const published = await executeToolCall(
          registry,
          {
            id: 'publish-multi-page-synthesis',
            name: 'publish_artifact',
            input: {
              kind: 'file',
              artifact_path: 'artifacts/multi-page-synthesis.md',
              roles: ['requested_output'],
              source_path: 'scratch/workspace/synthesis.md',
            },
          },
          toolContext,
        );
        expect(published.isError, published.content).toBe(false);

        const expectedDocument = [
          '# Multi-page synthesis',
          '',
          '## Main page',
          '',
          '- Title: Browser Controller Fixture',
          '- Heading: Browser controller fixture',
          `- URL: ${mainUrl}`,
          '',
          '## Popup page',
          '',
          '- Title: Popup Fixture',
          '- Heading: Popup fixture',
          `- URL: ${popupUrl}`,
          '',
          '',
        ].join('\n');
        const artifactPath = join(
          runDir,
          'artifacts/multi-page-synthesis.md',
        );
        const artifactBytes = readFileSync(artifactPath);
        expect(artifactBytes.toString('utf8')).toBe(expectedDocument);

        const requestedOutputs = readManifest(runDir).artifacts.filter(
          (entry) => entry.roles?.includes('requested_output') === true,
        );
        expect(requestedOutputs).toEqual([
          expect.objectContaining({
            filename: 'artifacts/multi-page-synthesis.md',
            sha256: createHash('sha256')
              .update(artifactBytes)
              .digest('hex'),
            roles: ['requested_output'],
          }),
        ]);

        const runOwnedPages = context.pages().filter(
          (page) => !preexistingPages.includes(page),
        );
        expect(runOwnedPages).toHaveLength(2);
        await controller.closeTaskPages();

        expect(await controller.pages()).toEqual([]);
        for (const page of runOwnedPages) expect(page.isClosed()).toBe(true);
        for (const page of preexistingPages) expect(page.isClosed()).toBe(false);
        expect(context.pages()).toEqual(preexistingPages);
        expect(await userPage.title()).toBe('User workspace');
        expect(await userPage.locator('#user-marker').textContent()).toBe(
          'Leave me open',
        );
      } finally {
        await controller?.closeTaskPages().catch(() => undefined);
        if (controller !== undefined) {
          await controller.close().catch(() => undefined);
        } else {
          await context?.close().catch(() => undefined);
        }
        await fixtureServer?.close().catch(() => undefined);
        await Promise.all([
          rm(profileDir, { recursive: true, force: true }),
          rm(runDir, { recursive: true, force: true }),
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
