// Demo for T11-T13 (V2): observe -> browser_action -> screenshot/download,
// the complete browser-tool walk against the deterministic local fixture
// server. Consolidates the old separate observe/act/evidence demos now that
// the V1 tool set (navigate, inspect_page, click, type, scroll) has been
// replaced by two tools: `observe` (look at a page) and `browser_action`
// (act on one, with ops navigate/click/fill/scroll/...).
// Run with: npx tsx demos/11-browser-tools.ts

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BrowserObservation, ElementRef } from '../src/browser/browserState.js';
import { LocalChromeBrowserSessionProvider } from '../src/browser/playwrightBrowserController.js';
import { finalizeManifest, initManifest, MANIFEST_FILENAME } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { browserActionTool } from '../src/tools/browserAction/browserAction.js';
import { createScreenshotTool, downloadTool } from '../src/tools/index.js';
import { observeTool } from '../src/tools/observe/observe.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';
import { startFixtureServer } from '../tests/fixtures/server.js';

const runDir = createRunDir('runs', generateRunId('demo browser-tools'));
initManifest(runDir, 'demo: observe, act, and capture evidence on local fixtures');

const fixtureServer = await startFixtureServer();
const browserSessionProvider = new LocalChromeBrowserSessionProvider({
  profileDir: resolve('chrome-profile'),
});
const browser = await browserSessionProvider.createSession();
// No contract in this demo, so captures are recorded as plain evidence.
const screenshotTool = createScreenshotTool({ contract: () => undefined });
const registry = createRegistry([observeTool, browserActionTool, screenshotTool, downloadTool]);
const ctx = { runDir, browser };

let callNumber = 0;
async function call(name: string, input: unknown): Promise<string> {
  callNumber += 1;
  const result = await executeToolCall(registry, { id: `demo-${callNumber}`, name, input }, ctx);
  if (result.isError) throw new Error(result.content);
  return result.content;
}

/** Find an observed element by its accessible role and name — same
 * approach the tool's own tests use: copy the element object verbatim into
 * a later browser_action target, never re-derive one by hand. */
function elementRef(observation: BrowserObservation, role: string, name: string): ElementRef {
  const match = observation.elements.find((el) => el.role === role && el.name === name);
  if (match === undefined) {
    throw new Error(
      `No observed ${role} "${name}" in ${JSON.stringify(
        observation.elements.map((el) => [el.role, el.name]),
      )}`,
    );
  }
  return match;
}

try {
  await browser.newTab();

  // 1. observe: navigate to the actions fixture, then look at it. Every
  // navigation goes through browser_action (op 'navigate') — there is no
  // separate navigate tool in V2.
  console.log('--- 1. navigate + observe ---');
  await call('browser_action', {
    actions: [{ op: 'navigate', url: fixtureServer.url('/actions.html') }],
  });
  let observation = JSON.parse(await call('observe', {})) as BrowserObservation;
  console.log(`observed page: ${observation.page.url} (observationId ${observation.page.observationId})`);

  // 2. browser_action: fill the name field and save the draft, with a
  // successCheck stating what "the change actually committed" means.
  console.log('\n--- 2. browser_action: fill + click, with a successCheck ---');
  const nameField = elementRef(observation, 'textbox', 'Full name');
  const saveButton = elementRef(observation, 'button', 'Save draft');
  console.log(
    await call('browser_action', {
      actions: [
        { op: 'fill', target: nameField, text: 'Quarterly Controls Review' },
        { op: 'click', target: saveButton },
      ],
      successChecks: [
        { type: 'text_present', text: 'Draft saved for Quarterly Controls Review' },
      ],
    }),
  );

  observation = JSON.parse(await call('observe', { need: ['interactive', 'text'] })) as BrowserObservation;
  const textView = observation.views.find((view) => view.need === 'text');
  console.log(`\npage text after the action:\n${textView?.content}`);

  // 3. screenshot: capture the acted-on page as evidence.
  console.log('\n--- 3. screenshot ---');
  console.log(await call('screenshot', { filename: 'evidence/actions-page.png', fullPage: true }));

  // 4. download: fetch a linked file through the browser's own session
  // (cookies, auth, everything intact) rather than a bare HTTP request.
  console.log('\n--- 4. download ---');
  await call('browser_action', {
    actions: [{ op: 'navigate', url: fixtureServer.url('/downloads.html') }],
  });
  observation = JSON.parse(await call('observe', {})) as BrowserObservation;
  const downloadLink = elementRef(observation, 'link', 'Download authenticated evidence');
  console.log(await call('download', { ref: downloadLink.id, filename: 'evidence/authenticated.bin' }));
} finally {
  const cleanup = await Promise.allSettled([browser.closeTab(), browser.close(), fixtureServer.close()]);
  finalizeManifest(runDir);
  const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure !== undefined) throw failure.reason;
}

console.log(`\n--- ${MANIFEST_FILENAME} ---`);
console.log(readFileSync(resolve(runDir, MANIFEST_FILENAME), 'utf8'));
console.log(
  `Verify the screenshot with: shasum -a 256 ${resolve(runDir, 'evidence/actions-page.png')}`,
);
