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
import type { ElementRef } from '../src/browser/browserState.js';
import type { BrowserController } from '../src/browser/controller.js';
import { findDevRoot, loadFirstEnvFile, resolveSherlockPaths } from '../src/config/paths.js';
import { createRunDir } from '../src/run/runDir.js';
import { generateRunId } from '../src/run/runId.js';

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
  document.body.appendChild(text);
  const file = document.createElement('input');
  file.type = 'file';
  file.id = 'smoke-file';
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

async function evaluate(browser: BrowserController, code: string): Promise<unknown> {
  const result = await browser.executeJavaScript?.({ code, timeoutMs: 10_000 });
  return result?.value;
}

/**
 * Resolve a full {@link ElementRef} the way the model does: from the
 * observation's `elements` array, by the ARIA role and accessible name each
 * one carries. A hand-built `{ ref: 'e1' }` is not what the action API takes,
 * and faking one here would test a shape the agent never produces.
 *
 * Deliberately NOT by parsing `[ref=…]` out of the outline: those stamps are
 * Playwright's internal aria-refs, while an `ElementRef.id` is the
 * store-scoped `el-N` issued by `stampOutlineElements`. The two never match,
 * so an outline-parsing lookup silently resolves nothing.
 */
function findElement(
  elements: readonly ElementRef[],
  role: string,
  name?: string,
): ElementRef | undefined {
  return elements.find(
    (element) => element.role === role && (name === undefined || element.name === name),
  );
}

/**
 * The OTHER handle an observation yields: the bare Playwright aria-ref stamped
 * in the outline. `download` takes this one (`locatorForRef` rejects anything
 * that is not `e12`/`f1e8`), while `browserAction` takes the {@link ElementRef}
 * above — so a script that feeds one where the other is expected fails without
 * ever touching the page.
 */
function findAriaRef(outline: string, needle: string): string | undefined {
  const line = outline.split('\n').find((candidate) => candidate.includes(needle));
  return line?.match(/\[ref=([^\]]+)\]/)?.[1];
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
    'browser scripts are explicitly unsupported',
    browser.prepareForBrowserScript === undefined &&
      browser.refreshAfterBrowserScript === undefined,
  );
  if (diagnostics?.liveViewUrl !== undefined) {
    console.log(`  live view: ${diagnostics.liveViewUrl}`);
  }

  try {
    // --- 2. Tab lifecycle, navigation, observation, actions. ---
    section('2. navigation, observation, actions');
    await browser.newTab();
    await browser.goto(FIXTURE_PAGE_URL);
    check('landed on the fixture page', browser.currentUrl().startsWith('https://example.com'));
    check('read a document title', (await browser.title()).length > 0);
    const outline = await browser.outline();
    check('outline is non-empty', outline.length > 0);
    const observation = await browser.observe({ need: ['interactive', 'text'] });
    check('observation has views', observation.views.length === 2);
    check('one page is tracked', (await browser.pages()).length === 1);

    check('page JavaScript is available', browser.executeJavaScript !== undefined);
    check('fixture built in-page', (await evaluate(browser, BUILD_FIXTURE_JS)) === 'built');
    const fixture = await browser.observe({ need: ['interactive'] });
    const fixtureOutline = fixture.views[0]?.content ?? '';
    const textElement = findElement(fixture.elements, 'textbox');
    // Chrome exposes a file input as a button, so that is the role it carries.
    const fileElement = findElement(fixture.elements, 'button');
    const downloadElement = findElement(fixture.elements, 'link', 'download me');
    const downloadAriaRef = findAriaRef(fixtureOutline, 'download me');
    check(
      'fixture refs were observed',
      textElement !== undefined && fileElement !== undefined && downloadElement !== undefined,
      fixtureOutline.slice(0, 200),
    );

    if (textElement !== undefined) {
      const filled = await browser.browserAction({
        actions: [{ op: 'fill', target: textElement, text: 'smoke' }],
        runDir,
      });
      check(
        'fill action committed',
        filled.actionReceipts[0]?.status === 'completed',
        JSON.stringify(filled.actionReceipts[0]),
      );
      check(
        'the page really holds the filled value',
        (await evaluate(browser, "document.getElementById('smoke-text').value")) === 'smoke',
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
    if (fileElement !== undefined) {
      const uploaded = await browser.browserAction({
        actions: [
          { op: 'upload', target: fileElement, runPath: 'scratch/workspace/smoke-upload.csv' },
        ],
        runDir,
      });
      check(
        'upload action committed',
        uploaded.actionReceipts[0]?.status === 'completed',
        JSON.stringify(uploaded.actionReceipts[0]),
      );
      check(
        'the remote page received the file name',
        (await evaluate(browser, "document.getElementById('smoke-file').files[0]?.name")) ===
          'smoke-upload.csv',
      );
      check(
        'the remote page received the file BYTES',
        (await evaluate(browser, "document.getElementById('smoke-file').files[0]?.size")) ===
          Buffer.byteLength(uploadPayload),
        'a path-based upload to a remote browser attaches nothing',
      );
    } else {
      check('file input ref was observed', false, 'could not resolve the file input');
    }

    // --- 5. PDF rendering. ---
    section('5. PDF rendering');
    const pageSource = browser.pdfPageSource?.();
    check('pdfPageSource is available', pageSource !== undefined);
    if (pageSource !== undefined) {
      const renderPage = await pageSource.newPage();
      try {
        await renderPage.route('**/*', (route) => {
          void route.abort('blockedbyclient');
        });
        await renderPage.setContent(
          '<html><body><h1>browserbase smoke</h1></body></html>',
          { waitUntil: 'load' },
        );
        await renderPage.emulateMedia({ media: 'print' });
        const pdf = await renderPage.pdf({
          format: 'Letter',
          printBackground: true,
          displayHeaderFooter: false,
        });
        check(
          'rendered real PDF bytes',
          pdf.length > 500 && Buffer.from(pdf.slice(0, 5)).toString() === '%PDF-',
          `${pdf.length} bytes`,
        );
      } finally {
        await renderPage.close();
      }
    }

    // --- 6. Downloads, both paths. ---
    section('6. downloads');
    const direct = await browser.download({ url: DIRECT_DOWNLOAD_URL });
    check(
      'direct-navigation download returned bytes',
      direct.bytes.length > 0 && direct.status === 200,
      `${direct.bytes.length} bytes, status ${String(direct.status)}`,
    );
    if (downloadAriaRef === undefined) {
      check('download link aria-ref was observed', false, fixtureOutline.slice(0, 200));
    } else {
      // A blob href is not HTTP(S), so this takes the CLICK path: a real
      // browser download event, which on Browserbase means the file lands in
      // the remote container and has to be fetched back and checksum-verified.
      // This is the single most Browserbase-specific behavior in the script,
      // so a throw here is recorded and stepped over rather than allowed to
      // abort the run before the context-persistence section.
      try {
        const clicked = await browser.download({ ref: downloadAriaRef });
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

    await browser.closeTab();
  } finally {
    // --- 7. Clean shutdown, with nothing left running. ---
    section('7. clean shutdown');
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
  try {
    await writing.newTab();
    await writing.goto(FIXTURE_PAGE_URL);
    await evaluate(
      writing,
      `document.cookie = 'smoke=${cookieValue}; path=/; max-age=3600'; document.cookie`,
    );
    check(
      'cookie set in the first session',
      String(await evaluate(writing, 'document.cookie')).includes(cookieValue),
    );
  } finally {
    // Closing is what commits the Context — exactly as `npm run login` relies on.
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
  try {
    await reading.newTab();
    await reading.goto(FIXTURE_PAGE_URL);
    check(
      'cookie survived into a SECOND session on the same context',
      String(await evaluate(reading, 'document.cookie')).includes(cookieValue),
      'this is the mechanism a persisted Google/X login depends on',
    );
  } finally {
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
