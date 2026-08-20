/**
 * Live Browserbase smoke test. NOT part of `npm test`.
 *
 *   npm run smoke:browserbase
 *
 * `npm test` is hermetic and network-free, which is right — but it means every
 * unit test of the Browserbase provider runs against a fake SDK and a fake CDP
 * connector. Those pin the code's own decisions; none of them can tell you
 * whether a remote Chrome actually honors `Browser.setDownloadBehavior`,
 * whether an upload encoded as bytes arrives, or whether a Context really
 * persists a cookie across a session boundary. That is what this is for, and
 * why it is invoked deliberately rather than swept up by CI.
 *
 * It costs real Browserbase minutes and reaches the public internet. It exits
 * non-zero on the first failed check, and it releases every session it opens on
 * every path — a smoke test that leaks a billable session would be its own
 * worst bug.
 *
 * Deliberately NOT covered here: the Google Sheets and X login run. That needs
 * a human at a Live View and is `npm run login`; this script prints a pointer to
 * it at the end rather than pretending to automate it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BrowserbaseBrowserSessionProvider,
  createBrowserbaseClient,
  requireBrowserbaseApiKey,
} from '../src/browser/browserbaseBrowserSessionProvider.js';
import type { BrowserCommandSession, BrowserController } from '../src/browser/controller.js';
import { findDevRoot, loadFirstEnvFile, resolveSherlockPaths } from '../src/config/paths.js';
import { createRunDir } from '../src/run/runDir.js';
import { generateRunId } from '../src/run/runId.js';
import { createBusyResourceRegistry } from '../src/tools/registry.js';

/** A public, tiny, extremely stable page to build fixtures on. A real origin
 * rather than `about:blank`, because a blob download inherits the page's origin
 * and `about:blank`'s is not one a download can be attributed to. */
const FIXTURE_PAGE_URL = 'https://example.com/';
/** A public, tiny, stable text file for the direct-navigation download path —
 * the one that returns bytes WITHOUT a browser download event, and so must keep
 * working untouched by any of the remote download plumbing. An RFC is used
 * because rfc-editor.org URLs are permanent by policy; the previous W3C fixture
 * had already rotted into a redirect to a 404, which this script reported as a
 * download failure. */
const DIRECT_DOWNLOAD_URL = 'https://www.rfc-editor.org/rfc/rfc2119.txt';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = resolveSherlockPaths({ devRoot: findDevRoot(PACKAGE_ROOT) });
loadFirstEnvFile(paths.envFileCandidates);

let failures = 0;
let checks = 0;

/** Record one check. Never throws: the point of a smoke test is to learn
 * everything that is broken in one run, not only the first thing. */
function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Inject the fixture elements this script drives. Built in-page rather than
 * served, because a Browserbase browser cannot reach a fixture server running
 * on this machine — no localhost, no tunnel. */
const BUILD_FIXTURE_JS = `
  document.body.innerHTML = '';
  const text = document.createElement('input');
  text.id = 'smoke-text';
  text.setAttribute('aria-label', 'Smoke text');
  document.body.appendChild(text);
  const file = document.createElement('input');
  file.type = 'file';
  file.id = 'smoke-file';
  file.setAttribute('aria-label', 'Smoke file');
  document.body.appendChild(file);
  const link = document.createElement('a');
  link.id = 'smoke-download';
  link.download = 'smoke-download.txt';
  link.textContent = 'download me';
  link.href = URL.createObjectURL(new Blob(['browserbase smoke payload'], { type: 'text/plain' }));
  document.body.appendChild(link);
  'built';
`;

const EXPECTED_DOWNLOAD_BYTES = 'browserbase smoke payload';

interface AccessibilityNode {
  role?: { value?: unknown };
  name?: { value?: unknown };
  backendDOMNodeId?: unknown;
}

async function prepareTaskPage(
  browser: BrowserController,
  ownershipId: string,
  startUrl: string,
): Promise<void> {
  if (browser.prepareTaskPage === undefined) {
    throw new Error('Browserbase smoke requires task-page preparation');
  }
  browser.setBusyRegistry?.(createBusyResourceRegistry());
  await browser.prepareTaskPage({ ownershipId, startUrl });
}

async function evaluate(session: BrowserCommandSession, expression: string): Promise<unknown> {
  const response = (await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: {
      text?: unknown;
      exception?: { description?: unknown };
    };
  };
  if (response.exceptionDetails !== undefined) {
    const description = response.exceptionDetails.exception?.description;
    throw new Error(
      typeof description === 'string'
        ? description
        : String(response.exceptionDetails.text ?? 'browser evaluation failed'),
    );
  }
  return response.result?.value;
}

async function accessibilityNodes(
  session: BrowserCommandSession,
): Promise<readonly AccessibilityNode[]> {
  const response = (await session.send('Accessibility.getFullAXTree')) as {
    nodes?: unknown;
  };
  return Array.isArray(response.nodes) ? (response.nodes as AccessibilityNode[]) : [];
}

function findBackendNodeId(
  nodes: readonly AccessibilityNode[],
  role: string,
  name: string,
): number | undefined {
  const backendDOMNodeId = nodes.find(
    (node) => node.role?.value === role && node.name?.value === name,
  )?.backendDOMNodeId;
  return Number.isInteger(backendDOMNodeId) && (backendDOMNodeId as number) > 0
    ? (backendDOMNodeId as number)
    : undefined;
}

async function fillBackendNode(
  session: BrowserCommandSession,
  backendDOMNodeId: number,
  value: string,
): Promise<void> {
  const resolved = (await session.send('DOM.resolveNode', {
    backendNodeId: backendDOMNodeId,
  })) as { object?: { objectId?: unknown } };
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new Error('Smoke text input could not be resolved');
  }
  try {
    const response = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(value) {
        this.value = value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value }],
      returnByValue: true,
    })) as { exceptionDetails?: unknown };
    if (response.exceptionDetails !== undefined) {
      throw new Error('Smoke text input could not be filled');
    }
  } finally {
    await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const apiKey = requireBrowserbaseApiKey();
  const client = createBrowserbaseClient(apiKey);
  const runDir = createRunDir(paths.runsBaseDir, generateRunId('browserbase smoke'));
  console.log(`run directory: ${runDir}`);

  // --- 1. Session creation, recording, and observability. ---
  section('1. session creation');
  const provider = new BrowserbaseBrowserSessionProvider({
    apiKey,
    recordSession: true,
    liveView: true,
    userMetadata: { purpose: 'smoke' },
  });
  const browser = await provider.createSession();
  const diagnostics = browser.sessionDiagnostics;
  const sessionId = diagnostics?.sessionId;
  check('session id is reported', typeof sessionId === 'string' && sessionId !== '');
  check('provider is browserbase', diagnostics?.provider === 'browserbase');
  check('live view URL is available', diagnostics?.liveViewUrl !== undefined);
  check('recording/inspector URL is available', diagnostics?.recordingUrl !== undefined);
  // The invariant that matters most: nothing user-visible carries a session
  // CONTROL capability. A `wss://connect...` string here would be a leak.
  check(
    'diagnostics carry no CDP connection URL',
    !/wss?:\/\//i.test(JSON.stringify(diagnostics ?? {})),
    JSON.stringify(diagnostics ?? {}),
  );
  check(
    'provider-neutral browser command sessions are available',
    typeof browser.openCommandSession === 'function' &&
      typeof browser.refreshAfterExternalCommands === 'function',
  );
  if (diagnostics?.liveViewUrl !== undefined) {
    console.log(`  live view: ${diagnostics.liveViewUrl}`);
  }

  let commandSession: BrowserCommandSession | undefined;
  try {
    // --- 2. Task-page lifecycle, raw commands, and accessibility. ---
    section('2. task page, commands, accessibility');
    await prepareTaskPage(browser, `${runDir}:primary`, FIXTURE_PAGE_URL);
    commandSession = await browser.openCommandSession();
    check('landed on the fixture page', browser.currentUrl().startsWith('https://example.com'));
    check(
      'read a document title through the pinned command session',
      String(await evaluate(commandSession, 'document.title')).length > 0,
    );
    check('one page is tracked', (await browser.pages()).length === 1);

    check('fixture built in-page', (await evaluate(commandSession, BUILD_FIXTURE_JS)) === 'built');
    const nodes = await accessibilityNodes(commandSession);
    const textBackendNodeId = findBackendNodeId(nodes, 'textbox', 'Smoke text');
    // Chrome exposes a file input as a button.
    const fileBackendNodeId = findBackendNodeId(nodes, 'button', 'Smoke file');
    const downloadBackendNodeId = findBackendNodeId(nodes, 'link', 'download me');
    check(
      'fixture backend nodes were exposed by accessibility',
      textBackendNodeId !== undefined &&
        fileBackendNodeId !== undefined &&
        downloadBackendNodeId !== undefined,
      JSON.stringify(nodes.slice(0, 12)),
    );

    if (textBackendNodeId !== undefined) {
      await fillBackendNode(commandSession, textBackendNodeId, 'smoke');
      check(
        'backend-node fill committed',
        (await evaluate(commandSession, "document.getElementById('smoke-text').value")) === 'smoke',
      );
    }

    // --- 3. Screenshot. ---
    section('3. screenshot');
    const png = await browser.screenshot({ fullPage: true });
    // PNG magic number: a remote screenshot that silently returned an empty or
    // HTML body would otherwise pass a length check.
    check(
      'screenshot is real PNG bytes',
      png.length > 1000 && png[0] === 0x89 && png[1] === 0x50,
      `${png.length} bytes`,
    );

    // --- 4. Upload from a confined run path. ---
    // The case Playwright gets wrong for a CDP-connected remote browser: it
    // would send this absolute path to a container that has no such file. See
    // src/browser/uploadEncoder.ts.
    section('4. upload from a confined run path');
    const workspace = join(runDir, 'scratch', 'workspace');
    mkdirSync(workspace, { recursive: true });
    const uploadPayload = 'id,value\n1,smoke\n';
    writeFileSync(join(workspace, 'smoke-upload.csv'), uploadPayload);
    if (fileBackendNodeId !== undefined) {
      await commandSession.upload(fileBackendNodeId, join(workspace, 'smoke-upload.csv'));
      check(
        'the remote page received the file name',
        (await evaluate(commandSession, "document.getElementById('smoke-file').files[0]?.name")) ===
          'smoke-upload.csv',
      );
      check(
        'the remote page received the file BYTES',
        (await evaluate(commandSession, "document.getElementById('smoke-file').files[0]?.size")) ===
          Buffer.byteLength(uploadPayload),
        'a path-based upload to a remote browser attaches nothing',
      );
    } else {
      check('file input backend node was observed', false);
    }

    // --- 5. PDF rendering through the same protected CDP boundary. ---
    section('5. PDF rendering');
    const printed = (await commandSession.send('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      paperWidth: 8.5,
      paperHeight: 11,
    })) as { data?: unknown };
    const pdf = Buffer.from(typeof printed.data === 'string' ? printed.data : '', 'base64');
    check(
      'rendered real PDF bytes',
      pdf.length > 500 && pdf.subarray(0, 5).toString() === '%PDF-',
      `${pdf.length} bytes`,
    );

    // --- 6. Downloads, both paths. ---
    section('6. downloads');
    const direct = await browser.download({ url: DIRECT_DOWNLOAD_URL });
    check(
      'direct-navigation download returned bytes',
      direct.bytes.length > 0 && direct.status === 200,
      `${direct.bytes.length} bytes, status ${String(direct.status)}`,
    );
    if (downloadBackendNodeId === undefined) {
      check('download link backend node was observed', false);
    } else {
      // A blob href is not HTTP(S), so this takes the CLICK path: a real
      // browser download event, which on Browserbase means the file lands in
      // the remote container and has to be fetched back and checksum-verified.
      // This is the single most Browserbase-specific behavior in the script,
      // so a throw here is recorded and stepped over rather than allowed to
      // abort the run before the context-persistence section.
      try {
        const clicked = await browser.download({
          backendNodeId: downloadBackendNodeId,
        });
        check(
          'browser-event download returned the exact bytes',
          Buffer.from(clicked.bytes).toString('utf8') === EXPECTED_DOWNLOAD_BYTES,
          `got ${JSON.stringify(Buffer.from(clicked.bytes).toString('utf8').slice(0, 60))}`,
        );
        check(
          'browser-event download kept the suggested filename',
          clicked.suggestedFilename === 'smoke-download.txt',
          clicked.suggestedFilename,
        );
      } catch (error) {
        check(
          'browser-event download returned the exact bytes',
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    await commandSession.close();
    commandSession = undefined;
    await browser.closeTaskPages();
  } finally {
    // --- 7. Clean shutdown, with nothing left running. ---
    section('7. clean shutdown');
    await commandSession?.close().catch(() => undefined);
    await browser.closeTaskPages().catch(() => undefined);
    await browser.close();
    await browser.close(); // idempotent
    if (sessionId !== undefined) {
      const status = await sessionStatus(client, sessionId);
      check(
        'the remote session is no longer running',
        status !== 'RUNNING' && status !== 'PENDING',
        `status ${status}`,
      );
    }
  }

  // --- 8. Context persistence, on a synthetic login fixture. ---
  // A cookie stands in for a login: same mechanism, no credentials, and it
  // isolates "does Browserbase persist a Context across a session boundary"
  // from "will Google accept a cloud browser", which are two different
  // questions and only the first one is this script's business.
  section('8. context persistence across a session boundary');
  const context = await client.contexts.create({});
  console.log(`  temporary context: ${context.id}`);
  const cookieValue = `smoke-${createHash('sha256').update(context.id).digest('hex').slice(0, 12)}`;
  const writer = new BrowserbaseBrowserSessionProvider({
    apiKey,
    contextId: context.id,
    persistContext: true,
    liveView: false,
  });
  const writing = await writer.createSession();
  let writingSession: BrowserCommandSession | undefined;
  try {
    await prepareTaskPage(writing, `${runDir}:context-writer`, FIXTURE_PAGE_URL);
    writingSession = await writing.openCommandSession();
    await evaluate(
      writingSession,
      `document.cookie = 'smoke=${cookieValue}; path=/; max-age=3600'; document.cookie`,
    );
    check(
      'cookie set in the first session',
      String(await evaluate(writingSession, 'document.cookie')).includes(cookieValue),
    );
  } finally {
    // Closing is what commits the Context — exactly as `npm run login` relies on.
    await writingSession?.close().catch(() => undefined);
    await writing.closeTaskPages().catch(() => undefined);
    await writing.close();
  }

  // Browserbase writes the Context's user-data-directory asynchronously after
  // the owning session ends; reopening immediately can read the pre-write state.
  await new Promise((done) => setTimeout(done, 5_000));

  const reader = new BrowserbaseBrowserSessionProvider({
    apiKey,
    contextId: context.id,
    persistContext: false,
    liveView: false,
  });
  const reading = await reader.createSession();
  let readingSession: BrowserCommandSession | undefined;
  try {
    await prepareTaskPage(reading, `${runDir}:context-reader`, FIXTURE_PAGE_URL);
    readingSession = await reading.openCommandSession();
    check(
      'cookie survived into a SECOND session on the same context',
      String(await evaluate(readingSession, 'document.cookie')).includes(cookieValue),
      'this is the mechanism a persisted Google/X login depends on',
    );
  } finally {
    await readingSession?.close().catch(() => undefined);
    await reading.closeTaskPages().catch(() => undefined);
    await reading.close();
    await client.contexts.delete?.(context.id).catch(() => undefined);
  }

  section('summary');
  console.log(`  ${checks - failures}/${checks} checks passed`);
  console.log(
    '\nStill a human step: `npm run login` verifies a real Google Sheets and X sign-in\n' +
      'through Live View. No script can answer whether those services accept a cloud browser.',
  );
  if (failures > 0) process.exitCode = 1;
}

/** Current status of a session, for the "nothing left running" check. */
async function sessionStatus(
  client: ReturnType<typeof createBrowserbaseClient>,
  sessionId: string,
): Promise<string> {
  try {
    const sessions = await (
      client as unknown as {
        sessions: { retrieve(id: string): Promise<{ status?: string }> };
      }
    ).sessions.retrieve(sessionId);
    return sessions.status ?? 'unknown';
  } catch (error) {
    return `unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
}

await main().catch((error: unknown) => {
  console.error(`\nsmoke test aborted: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
