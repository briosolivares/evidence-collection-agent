// Demo for T12: act on refs through the full tool pipeline, verify the form
// through inspect_page, then use the scroll -> inspect lazy-load pattern.
// Run with: npx tsx demos/12-act.ts

import { resolve } from 'node:path';

import { launchPersistentChrome } from '../src/browser/playwrightAdapter.js';
import { finalizeManifest, initManifest } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';
import { actionTools } from '../src/tools/actionTools.js';
import { observationTools } from '../src/tools/observationTools.js';
import { executeToolCall } from '../src/tools/pipeline.js';
import { createRegistry } from '../src/tools/registry.js';
import { startFixtureServer } from '../tests/fixtures/server.js';

const runDir = createRunDir('runs', generateRunId());
initManifest(runDir, 'demo: act on a fixture form and lazy list');

const fixtureServer = await startFixtureServer();
const browser = await launchPersistentChrome({
  profileDir: resolve('chrome-profile'),
});
const registry = createRegistry([...observationTools, ...actionTools]);
let callNumber = 0;

async function call(name: string, input: unknown): Promise<string> {
  callNumber += 1;
  const result = await executeToolCall(
    registry,
    { id: `demo-${callNumber}`, name, input },
    { runDir, browser },
  );
  if (result.isError) throw new Error(result.content);
  return result.content;
}

function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(
    new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`),
  );
  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName}`);
  }
  return match[1];
}

try {
  await browser.newTab();
  await call('navigate', { url: fixtureServer.url('/') });
  const formBefore = await call('inspect_page', {});
  const inputRef = refFor(formBefore, 'textbox "Evidence query"');
  const buttonRef = refFor(formBefore, 'button "Announce ready"');

  console.log(await call('type', { ref: inputRef, text: 'quarterly controls' }));
  console.log(await call('click', { ref: buttonRef }));
  console.log(`\n--- form after actions ---\n${await call('inspect_page', {})}`);

  await call('navigate', { url: fixtureServer.url('/lazy-load.html') });
  let lazyOutline = await call('inspect_page', {});
  for (let attempts = 0; attempts < 4 && !lazyOutline.includes('Lazy evidence item 20'); attempts += 1) {
    console.log(await call('scroll', {}));
    lazyOutline = await call('inspect_page', {});
  }
  if (!lazyOutline.includes('Lazy evidence item 20')) {
    throw new Error('Lazy list did not load 20 evidence items');
  }
  console.log('\nLazy list loaded through item 20.');
} finally {
  finalizeManifest(runDir);
  await browser.closeTab();
  await browser.close();
  await fixtureServer.close();
}
