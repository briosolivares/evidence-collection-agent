import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright';

import { createBusyResourceRegistry } from '../../src/tools/registry.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { AttachedChromeBrowserSessionProvider } from '../../src/browser/attachedChromeBrowserSessionProvider.js';
import {
  BrowserbaseBrowserSessionProvider,
  type BrowserbaseClient,
} from '../../src/browser/browserbaseBrowserSessionProvider.js';
import type {
  BrowserCommandSession,
  BrowserController,
  BrowserDownloadResult,
} from '../../src/browser/controller.js';
import { localDownloadReader } from '../../src/browser/downloadReader.js';
import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import type { BrowserSessionDiagnostics } from '../../src/browser/sessionProvider.js';
import { localUploadEncoder, remoteUploadEncoder } from '../../src/browser/uploadEncoder.js';

const TEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_BYTES = Buffer.from('browser-native-download\n');
const UPLOAD_BYTES = Buffer.from('provider-contract-upload\n');
const BROWSERBASE_API_KEY = 'provider-matrix-private-api-key';
const BROWSERBASE_CONNECT_URL =
  'wss://connect.browserbase.com/v1/provider-matrix-private-control-url';
const BROWSERBASE_SESSION_ID = 'provider-matrix-session';
const BROWSERBASE_LIVE_VIEW_URL =
  'https://debug.browserbase.com/fullscreen/provider-matrix-session';
const ATTACHED_CONNECT_URL = 'http://127.0.0.1:9222/provider-matrix-private-control-url';

type ProviderKind = 'managed-local' | 'attached-local' | 'browserbase-fake';
type StrategyKind = 'local' | 'remote';
type AsyncCloseMock = ReturnType<typeof vi.fn<() => Promise<void>>>;
type BrowserbaseReleaseMock = ReturnType<
  typeof vi.fn<(id: string, params: { status: 'REQUEST_RELEASE' }) => Promise<unknown>>
>;

interface ProviderContractCase {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly uploadStrategy: StrategyKind;
  readonly downloadStrategy: StrategyKind;
}

interface ProviderHarness {
  readonly controller: BrowserController;
  readonly rootDir: string;
  readonly ambientPages: Page[];
  readonly ownerContext?: BrowserContext;
  readonly controlSecrets: readonly string[];
  readonly expectedDiagnostics: BrowserSessionDiagnostics | undefined;
  readonly remoteDownloadRequests: string[];
  assertCloseEffects(): void;
  cleanup(): Promise<void>;
}

const PROVIDERS: readonly ProviderContractCase[] = [
  {
    name: 'managed local',
    kind: 'managed-local',
    uploadStrategy: 'local',
    downloadStrategy: 'local',
  },
  {
    name: 'attached local',
    kind: 'attached-local',
    uploadStrategy: 'local',
    downloadStrategy: 'local',
  },
  {
    name: 'Browserbase fake',
    kind: 'browserbase-fake',
    uploadStrategy: 'remote',
    downloadStrategy: 'remote',
  },
];

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture?.close();
});

describe('provider-neutral browser contract', () => {
  it.each(PROVIDERS)(
    '$name satisfies the same command/upload/download/cleanup contract',
    async (providerCase) => {
      const localUpload = vi.spyOn(localUploadEncoder, 'encode');
      const remoteUpload = vi.spyOn(remoteUploadEncoder, 'encode');
      const localDownload = vi.spyOn(localDownloadReader, 'read');
      let harness: ProviderHarness | undefined;

      try {
        harness = await createProviderHarness(providerCase.kind);
        const { controller } = harness;
        controller.setBusyRegistry?.(createBusyResourceRegistry());
        if (controller.prepareTaskPage === undefined) {
          throw new Error(`${providerCase.name} omitted task-page preparation`);
        }

        await controller.prepareTaskPage({
          ownershipId: `provider-contract-${providerCase.kind}`,
          startUrl: fixture.url('/index.html'),
        });
        expect(await controller.pages()).toEqual([
          expect.objectContaining({ active: true, url: fixture.url('/index.html') }),
        ]);

        // Attached clients and the Browserbase fake have an independent owner
        // connection. A tab opened there during the run has no run marker or
        // owned opener and must remain ambient.
        if (harness.ownerContext !== undefined) {
          const concurrentAmbient = await harness.ownerContext.newPage();
          await concurrentAmbient.goto(`${fixture.url('/index.html')}#ambient`);
          harness.ambientPages.push(concurrentAmbient);
          expect(await controller.pages()).toHaveLength(1);
        }

        const uploadPath = join(harness.rootDir, 'provider-contract-upload.txt');
        await writeFile(uploadPath, UPLOAD_BYTES);
        const command = await controller.openCommandSession();
        const observedPublicValues: unknown[] = [
          controller.sessionDiagnostics,
          {
            pageId: command.pageId,
            targetId: command.targetId,
            keys: Object.keys(command).sort(),
          },
        ];

        expect(Object.keys(command).sort()).toEqual([
          'close',
          'navigate',
          'pageId',
          'send',
          'targetId',
          'upload',
        ]);
        expect(await evaluateValue(command, '6 * 7')).toBe(42);

        await installContractFixture(command, fixture.url('/browser-only.bin'));
        const uploadNodeId = await backendNodeId(command, '#provider-upload');
        const downloadNodeId = await backendNodeId(command, '#provider-download');
        await command.upload(uploadNodeId, uploadPath);
        expect(await evaluateValue(command, uploadObservationExpression())).toEqual({
          name: 'provider-contract-upload.txt',
          text: UPLOAD_BYTES.toString('utf8'),
        });

        if (providerCase.uploadStrategy === 'local') {
          expect(localUpload).toHaveBeenCalledOnce();
          expect(localUpload).toHaveBeenCalledWith([uploadPath]);
          expect(remoteUpload).not.toHaveBeenCalled();
        } else {
          expect(remoteUpload).toHaveBeenCalledOnce();
          expect(remoteUpload).toHaveBeenCalledWith([uploadPath]);
          expect(localUpload).not.toHaveBeenCalled();
        }

        await command.send('Runtime.evaluate', {
          expression: "window.open('about:blank#provider-contract-popup', '_blank')",
        });
        await waitForOwnedPageCount(controller, 2);

        await command.close();
        await command.close();
        let closedCommandMessage = '';
        try {
          await command.send('Runtime.evaluate', { expression: '1' });
        } catch (error) {
          closedCommandMessage = error instanceof Error ? error.message : String(error);
        }
        expect(closedCommandMessage).toMatch(/command session.*closed/i);
        observedPublicValues.push(closedCommandMessage);

        const downloaded = await controller.download({ backendNodeId: downloadNodeId });
        assertDownload(downloaded);
        observedPublicValues.push({
          finalUrl: downloaded.finalUrl,
          suggestedFilename: downloaded.suggestedFilename,
          byteHash: createHash('sha256').update(downloaded.bytes).digest('hex'),
        });

        if (providerCase.downloadStrategy === 'local') {
          expect(localDownload).toHaveBeenCalledOnce();
          expect(harness.remoteDownloadRequests).toEqual([]);
        } else {
          expect(localDownload).not.toHaveBeenCalled();
          expect(harness.remoteDownloadRequests).toHaveLength(2);
          expect(harness.remoteDownloadRequests[0]).toContain(
            `/v1/downloads?sessionId=${BROWSERBASE_SESSION_ID}`,
          );
          expect(harness.remoteDownloadRequests[1]).toMatch(/\/v1\/downloads\/matrix-download$/);
        }

        expect(controller.sessionDiagnostics).toEqual(harness.expectedDiagnostics);
        const publicSnapshot = JSON.stringify(observedPublicValues);
        for (const secret of harness.controlSecrets) {
          expect(publicSnapshot).not.toContain(secret);
          expect(JSON.stringify(controller.sessionDiagnostics)).not.toContain(secret);
        }
        expect(
          Object.keys(controller.sessionDiagnostics ?? {}).some((key) =>
            /(?:cdp|connect|endpoint)/i.test(key),
          ),
        ).toBe(false);

        await controller.closeTaskPages();
        await controller.closeTaskPages();
        expect(await controller.pages()).toEqual([]);
        for (const ambientPage of harness.ambientPages) {
          expect(ambientPage.isClosed()).toBe(false);
        }

        // Concurrent calls plus a later repeat pin idempotence at the public
        // provider boundary. Provider-specific effect spies below prove the
        // attached disconnect and Browserbase release each happen once.
        await Promise.all([controller.close(), controller.close()]);
        await controller.close();
        harness.assertCloseEffects();
        for (const ambientPage of harness.ambientPages) {
          expect(ambientPage.isClosed()).toBe(false);
        }
      } finally {
        localUpload.mockRestore();
        remoteUpload.mockRestore();
        localDownload.mockRestore();
        await harness?.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

async function createProviderHarness(kind: ProviderKind): Promise<ProviderHarness> {
  switch (kind) {
    case 'managed-local':
      return createManagedLocalHarness();
    case 'attached-local':
      return createAttachedLocalHarness();
    case 'browserbase-fake':
      return createBrowserbaseHarness();
  }
}

async function createManagedLocalHarness(): Promise<ProviderHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'provider-contract-managed-'));
  let controller: BrowserController | undefined;
  try {
    controller = await new LocalChromeBrowserSessionProvider({
      profileDir: join(rootDir, 'profile'),
      headless: true,
    }).createSession();
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }

  return {
    controller,
    rootDir,
    ambientPages: [],
    controlSecrets: [],
    expectedDiagnostics: undefined,
    remoteDownloadRequests: [],
    assertCloseEffects: () => undefined,
    cleanup: async () => {
      await controller?.close().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function createAttachedLocalHarness(): Promise<ProviderHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'provider-contract-attached-'));
  let ownerContext: BrowserContext | undefined;
  let ownerBrowser: Browser | undefined;
  let controller: BrowserController | undefined;
  let clientClose: AsyncCloseMock | undefined;
  try {
    ownerBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    ownerContext = await ownerBrowser.newContext({ acceptDownloads: true });
    const firstAmbient = await ownerContext.newPage();
    const secondAmbient = await ownerContext.newPage();
    await secondAmbient.goto('about:blank#preexisting-ambient');
    const clientBrowser = detachableBrowserFacade(ownerBrowser);
    clientClose = clientBrowser.close;
    const provider = new AttachedChromeBrowserSessionProvider({
      cdpEndpoint: ATTACHED_CONNECT_URL,
      connectOverCDP: async (requestedEndpoint) => {
        expect(requestedEndpoint).toBe(ATTACHED_CONNECT_URL);
        return clientBrowser.browser;
      },
    });
    controller = await provider.createSession();

    return {
      controller,
      rootDir,
      ownerContext,
      ambientPages: [firstAmbient, secondAmbient],
      controlSecrets: [ATTACHED_CONNECT_URL],
      expectedDiagnostics: { provider: 'local' },
      remoteDownloadRequests: [],
      assertCloseEffects: () => expect(clientClose).toHaveBeenCalledOnce(),
      cleanup: async () => {
        await controller?.close().catch(() => undefined);
        await ownerBrowser?.close().catch(() => undefined);
        await rm(rootDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await controller?.close().catch(() => undefined);
    await ownerBrowser?.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

async function createBrowserbaseHarness(): Promise<ProviderHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'provider-contract-browserbase-'));
  let ownerContext: BrowserContext | undefined;
  let ownerBrowser: Browser | undefined;
  let controller: BrowserController | undefined;
  let clientClose: AsyncCloseMock | undefined;
  const release = vi.fn<(id: string, params: { status: 'REQUEST_RELEASE' }) => Promise<unknown>>(
    async () => undefined,
  );
  const clearHeartbeat = vi.fn((_handle: NodeJS.Timeout) => undefined);
  const heartbeatHandle = { providerContractHeartbeat: true } as unknown as NodeJS.Timeout;
  const remoteDownloadRequests: string[] = [];

  try {
    ownerBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    ownerContext = await ownerBrowser.newContext({ acceptDownloads: true });
    const sessionPage = await ownerContext.newPage();
    const clientBrowser = detachableBrowserFacade(ownerBrowser);
    clientClose = clientBrowser.close;
    const client = browserbaseClient(release);
    const provider = new BrowserbaseBrowserSessionProvider({
      apiKey: BROWSERBASE_API_KEY,
      client,
      connectOverCDP: async (connectUrl) => {
        expect(connectUrl).toBe(BROWSERBASE_CONNECT_URL);
        await interceptBrowserbaseDownloadSetup(
          clientBrowser.browser,
          join(rootDir, 'browserbase-downloads'),
        );
        return clientBrowser.browser;
      },
      fetchImpl: browserbaseDownloadFetch(remoteDownloadRequests),
      setInterval: () => heartbeatHandle,
      clearInterval: clearHeartbeat,
      onWarning: (message) => {
        throw new Error(`Unexpected Browserbase warning: ${message}`);
      },
    });
    controller = await provider.createSession();

    return {
      controller,
      rootDir,
      ownerContext,
      ambientPages: [sessionPage],
      controlSecrets: [BROWSERBASE_CONNECT_URL, BROWSERBASE_API_KEY],
      expectedDiagnostics: {
        provider: 'browserbase',
        sessionId: BROWSERBASE_SESSION_ID,
        liveViewUrl: BROWSERBASE_LIVE_VIEW_URL,
        recordingUrl: `https://browserbase.com/sessions/${BROWSERBASE_SESSION_ID}`,
      },
      remoteDownloadRequests,
      assertCloseEffects: () => {
        expect(clientClose).toHaveBeenCalledOnce();
        expect(clearHeartbeat).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledWith(BROWSERBASE_SESSION_ID, {
          status: 'REQUEST_RELEASE',
        });
      },
      cleanup: async () => {
        await controller?.close().catch(() => undefined);
        await ownerBrowser?.close().catch(() => undefined);
        await rm(rootDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await controller?.close().catch(() => undefined);
    await ownerBrowser?.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function browserbaseClient(release: BrowserbaseReleaseMock): BrowserbaseClient {
  return {
    sessions: {
      create: vi.fn(async () => ({
        id: BROWSERBASE_SESSION_ID,
        connectUrl: BROWSERBASE_CONNECT_URL,
      })),
      update: release,
      debug: vi.fn(async () => ({
        debuggerFullscreenUrl: BROWSERBASE_LIVE_VIEW_URL,
      })),
    },
    contexts: {
      create: vi.fn(async () => {
        throw new Error('Browserbase provider must not create a context in this journey');
      }),
    },
  };
}

/** Browserbase production asks its remote Chrome to write into `downloads`.
 * This fake is a local ephemeral Chrome, so record that exact provider request
 * but rewrite its path under the test temp root before the browser effect. The
 * provider's remote reader is still exercised below. */
async function interceptBrowserbaseDownloadSetup(
  browser: Browser,
  downloadDir: string,
): Promise<void> {
  await mkdir(downloadDir, { recursive: true });
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('Browserbase fake exposed no context');
  const newSession = context.newCDPSession.bind(context);
  let firstAttachment = true;
  vi.spyOn(context, 'newCDPSession').mockImplementation(async (page) => {
    const session = await newSession(page);
    if (!firstAttachment) return session;
    firstAttachment = false;
    return interceptDownloadBehavior(session, downloadDir);
  });
}

function interceptDownloadBehavior(session: CDPSession, downloadDir: string): CDPSession {
  const send = session.send.bind(session) as unknown as (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  return {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Browser.setDownloadBehavior') {
        expect(params).toEqual({
          behavior: 'allow',
          downloadPath: 'downloads',
          eventsEnabled: true,
        });
        return send(method, {
          ...params,
          downloadPath: downloadDir,
        });
      }
      return send(method, params);
    }),
    detach: () => session.detach(),
  } as unknown as CDPSession;
}

function detachableBrowserFacade(browser: Browser): {
  browser: Browser;
  close: AsyncCloseMock;
} {
  const disconnect = vi.fn(async () => undefined);
  return {
    close: disconnect,
    browser: new Proxy(browser, {
      get(target, property) {
        if (property === 'close') return disconnect;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }),
  };
}

function browserbaseDownloadFetch(requests: string[]): typeof fetch {
  const checksum = createHash('sha256').update(DOWNLOAD_BYTES).digest('hex');
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    expect(url).not.toContain(BROWSERBASE_API_KEY);
    expect((init?.headers as Record<string, string>)['x-bb-api-key']).toBe(BROWSERBASE_API_KEY);

    if (url.includes('/v1/downloads?')) {
      return jsonResponse({
        downloads: [
          {
            id: 'matrix-download',
            filename: 'javascript-evidence.bin',
            checksum,
            size: DOWNLOAD_BYTES.byteLength,
            createdAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      });
    }
    if (url.endsWith('/v1/downloads/matrix-download')) {
      return bytesResponse(DOWNLOAD_BYTES);
    }
    throw new Error(`Unexpected Browserbase download request: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as unknown as Response;
}

async function installContractFixture(
  session: BrowserCommandSession,
  downloadUrl: string,
): Promise<void> {
  const expression = `
    document.body.innerHTML =
      '<input id="provider-upload" type="file">' +
      '<button id="provider-download" type="button">Download</button>';
    document.querySelector('#provider-download').addEventListener('click', async () => {
      const response = await fetch(${JSON.stringify(downloadUrl)});
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href;
      link.download = 'javascript-evidence.bin';
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 0);
    });
    'ready';
  `;
  expect(await evaluateValue(session, expression)).toBe('ready');
}

function uploadObservationExpression(): string {
  return `new Promise((resolve, reject) => {
    const file = document.querySelector('#provider-upload').files[0];
    if (!file) {
      reject(new Error('no uploaded file'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve({ name: file.name, text: reader.result });
    reader.readAsText(file);
  })`;
}

async function evaluateValue(session: BrowserCommandSession, expression: string): Promise<unknown> {
  const result = (await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  expect(result.exceptionDetails).toBeUndefined();
  return result.result?.value;
}

async function backendNodeId(session: BrowserCommandSession, selector: string): Promise<number> {
  const document = (await session.send('DOM.getDocument')) as {
    root?: { nodeId?: number };
  };
  const rootNodeId = document.root?.nodeId;
  if (rootNodeId === undefined) throw new Error('DOM.getDocument returned no root node');
  const queried = (await session.send('DOM.querySelector', {
    nodeId: rootNodeId,
    selector,
  })) as { nodeId?: number };
  if (queried.nodeId === undefined || queried.nodeId === 0) {
    throw new Error(`Could not resolve ${selector}`);
  }
  const described = (await session.send('DOM.describeNode', {
    nodeId: queried.nodeId,
  })) as { node?: { backendNodeId?: number } };
  const backendNodeId = described.node?.backendNodeId;
  if (backendNodeId === undefined) {
    throw new Error(`DOM.describeNode returned no backend id for ${selector}`);
  }
  return backendNodeId;
}

function assertDownload(download: BrowserDownloadResult): void {
  expect(Buffer.from(download.bytes)).toEqual(DOWNLOAD_BYTES);
  expect(download.suggestedFilename).toBe('javascript-evidence.bin');
  expect(download.finalUrl).toMatch(/^blob:/);
  expect(download.headers).toEqual({});
}

async function waitForOwnedPageCount(
  controller: BrowserController,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const pages = await controller.pages();
    if (pages.length === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expected} owned pages; saw ${pages.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
