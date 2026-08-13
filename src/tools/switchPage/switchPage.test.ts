import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import type { BrowserActionOutput } from '../../browser/browserActions.js';
import type {
  BrowserObservation,
  ElementRef,
} from '../../browser/browserState.js';
import { browserActionTool } from '../browserAction/browserAction.js';
import { navigateTool } from '../navigate/navigate.js';
import { observeTool } from '../observe/observe.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { switchPageTool, type SwitchPageResult } from './switchPage.js';

describe('switch_page tool', () => {
  const suite = setupBrowserToolSuite('switch-page-tool');
  const registry = createRegistry([
    navigateTool,
    observeTool,
    browserActionTool,
    switchPageTool,
  ]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  async function openFixture(): Promise<BrowserObservation> {
    await call('navigate', { url: suite.server().url('/actions.html') });
    const result = await call('observe', {});
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as BrowserObservation;
  }

  function element(
    observation: BrowserObservation,
    role: string,
    name: string,
  ): ElementRef {
    const match = observation.elements.find(
      (candidate) => candidate.role === role && candidate.name === name,
    );
    if (match === undefined) {
      throw new Error(`No observed ${role} "${name}" on the fixture page.`);
    }
    return match;
  }

  async function switchTo(pageId: string): Promise<SwitchPageResult> {
    const result = await call('switch_page', { pageId });
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as SwitchPageResult;
  }

  it(
    'selects a popup that an action sequence opened, keeping refs page-bound',
    async () => {
      const observation = await openFixture();

      const output: BrowserActionOutput = JSON.parse(
        (
          await call('browser_action', {
            pageId: observation.page.pageId,
            documentId: observation.page.documentId,
            basedOnObservationId: observation.page.observationId,
            actions: [
              { op: 'click', target: element(observation, 'link', 'Open action popup') },
            ],
          })
        ).content,
      ) as BrowserActionOutput;

      // A popup on the final action is reported, not treated as a failure.
      expect(output.status).toBe('completed');
      expect(output.openedPages).toHaveLength(1);
      const popupId = output.openedPages[0]?.pageId ?? '';
      expect(popupId).not.toBe(observation.page.pageId);

      const switched = await switchTo(popupId);
      expect(switched.selected.pageId).toBe(popupId);
      expect(switched.selected.active).toBe(true);
      expect(switched.pages.map((page) => page.pageId)).toEqual(
        expect.arrayContaining([observation.page.pageId, popupId]),
      );
      await expect
        .poll(async () => (await switchTo(popupId)).selected.url, { timeout: 8_000 })
        .toContain('/second.html');

      // Selection does not launder a ref from another page into this one:
      // one sequence acts on one page, and the mismatch is refused before
      // any action runs.
      const rejected: BrowserActionOutput = JSON.parse(
        (
          await call('browser_action', {
            pageId: popupId,
            actions: [
              { op: 'click', target: element(observation, 'button', 'Save draft') },
            ],
          })
        ).content,
      ) as BrowserActionOutput;
      expect(rejected.status).toBe('failed');
      expect(rejected.actionReceipts).toEqual([]);
      expect(rejected.error).toContain('One sequence acts on one page');

      // Leave the suite with only its own tab selected.
      await suite.controller().closeTab();
      await switchTo(observation.page.pageId);
    },
    // Double the usual budget: this one test drives two sequences, a popup, a
    // poll for its landed URL, and tab cleanup — under a loaded parallel run
    // the single-test budget is genuinely tight.
    BROWSER_TEST_TIMEOUT_MS * 2,
  );

  it(
    'rejects an unknown or malformed page id',
    async () => {
      await openFixture();

      const unknown = await call('switch_page', { pageId: 'page-does-not-exist' });
      expect(unknown).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(unknown.content).toContain('Unknown or closed browser pageId');

      for (const input of [{}, { pageId: '' }, { pageId: 'page-1', extra: true }]) {
        const result = await call('switch_page', input);
        expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
