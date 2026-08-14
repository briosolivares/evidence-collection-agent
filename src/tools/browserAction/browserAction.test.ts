import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { observeTool } from '../observe/observe.js';
import { executeToolCall } from '../pipeline.js';
import { accessesConflict, accessKey, createRegistry } from '../registry.js';
import { browserActionTool, type BrowserActionInput } from './browserAction.js';

describe('browser_action tool', () => {
  const suite = setupBrowserToolSuite('browser-action-tool');
  const registry = createRegistry([observeTool, browserActionTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  /** Load the action fixture and return its first observation. */
  async function openFixture(path = '/actions.html'): Promise<BrowserObservation> {
    await call('browser_action', {
      actions: [{ op: 'navigate', url: suite.server().url(path) }],
    });
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
      throw new Error(
        `No observed ${role} "${name}" in ${JSON.stringify(
          observation.elements.map((candidate) => [candidate.role, candidate.name]),
        )}`,
      );
    }
    return match;
  }

  /** Every request carries the page/document the caller observed — that is
   * the precondition the receipts are meaningful against. */
  function requestFor(
    observation: BrowserObservation,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      pageId: observation.page.pageId,
      documentId: observation.page.documentId,
      basedOnObservationId: observation.page.observationId,
      ...extra,
    };
  }

  async function act(input: unknown): Promise<BrowserActionOutput> {
    const result = await call('browser_action', input);
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as BrowserActionOutput;
  }

  /** Exact rendered text of the selected page — the fixture reports every
   * committed effect in visible text, so this is the commit ledger. */
  async function pageText(): Promise<string> {
    const result = await call('observe', { need: ['text'] });
    expect(result.isError).toBe(false);
    const observation = JSON.parse(result.content) as BrowserObservation;
    return observation.views[0]?.content ?? '';
  }

  it(
    'commits every action of a form sequence and confirms it with a success check',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
            {
              op: 'select',
              target: element(observation, 'combobox', 'Plan'),
              values: ['pro'],
            },
            {
              op: 'check',
              target: element(observation, 'checkbox', 'Subscribe to updates'),
              checked: true,
            },
            { op: 'hover', target: element(observation, 'button', 'Hover probe') },
            { op: 'click', target: element(observation, 'button', 'Save draft') },
          ],
          successChecks: [
            {
              type: 'text_present',
              text: 'Draft saved for Ada Lovelace on plan pro (subscribed)',
            },
          ],
        }),
      );

      expect(output.status).toBe('completed');
      expect(
        output.actionReceipts.map((receipt) => [
          receipt.index,
          receipt.op,
          receipt.status,
          receipt.effectsCommitted,
        ]),
      ).toEqual([
        [0, 'fill', 'completed', true],
        [1, 'select', 'completed', true],
        [2, 'check', 'completed', true],
        [3, 'hover', 'completed', true],
        [4, 'click', 'completed', true],
      ]);
      expect(output.stoppedBeforeIndex).toBeUndefined();
      expect(output.stopReason).toBeUndefined();
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([true]);
      expect(output.settled).toBe(true);
      expect(output.blockedReason).toBeUndefined();
      expect(output.previousObservationId).toBe(observation.page.observationId);
      expect(output.changes.basis).toBe('requested_observation');
      expect(output.changes.navigated).toBe(false);
      expect(output.changesTruncated).toBe(false);
      // A same-document diff carries the picture, so no views are needed.
      expect(output.views).toBeUndefined();
      expect(output.currentPage.pageId).toBe(observation.page.pageId);
      expect(output.currentPage.documentId).toBe(observation.page.documentId);

      const text = await pageText();
      expect(text).toContain('Name echo: Ada Lovelace');
      expect(text).toContain('Hover: probed');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'leaves the page untouched when the requested document was already replaced',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          documentId: 'doc-from-a-page-that-is-gone',
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
          ],
        }),
      );

      expect(output.status).toBe('stale');
      expect(output.actionReceipts).toEqual([]);
      expect(output.stoppedBeforeIndex).toBe(0);
      expect(output.stopReason).toBe('document_replaced');
      expect(output.settled).toBe(false);
      expect(output.checks).toEqual([]);
      expect(output.error).toContain('Nothing was executed');
      // Untouched, not "probably fine": the fill never ran.
      expect(await pageText()).toContain('Name echo: (empty)');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'stops at a mid-sequence navigation and never acts on the replacement document',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
            { op: 'click', target: element(observation, 'button', 'Submit form') },
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Email address'),
              text: 'ada@example.test',
            },
          ],
        }),
      );

      expect(output.status).toBe('partial');
      expect(
        output.actionReceipts.map((receipt) => [receipt.op, receipt.status]),
      ).toEqual([
        ['fill', 'completed'],
        ['click', 'completed'],
      ]);
      expect(output.actionReceipts.every((receipt) => receipt.effectsCommitted)).toBe(
        true,
      );
      // The third action is named, not attempted.
      expect(output.stoppedBeforeIndex).toBe(2);
      expect(output.stopReason).toBe('navigation');
      expect(output.currentPage.url).toContain('/second.html');
      expect(output.currentPage.documentId).not.toBe(observation.page.documentId);
      expect(output.changes.navigated).toBe(true);
      expect(output.changes.url?.after).toContain('/second.html');
      // The replacement document comes back with usable refs, so the model
      // can retarget without a separate observe turn.
      expect(
        output.changes.newlyVisible.map((element) => [element.role, element.name]),
      ).toContainEqual(['link', 'Return to browser controller fixture']);
      expect(
        output.changes.newlyVisible.every(
          (element) => element.documentId === output.currentPage.documentId,
        ),
      ).toBe(true);

      const text = await pageText();
      expect(text).toContain('Second fixture page');
      expect(text).not.toContain('Name echo');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'reports a final submit-button navigation as completed, not an ambiguous failure',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
            { op: 'click', target: element(observation, 'button', 'Submit form') },
          ],
          successChecks: [{ type: 'url_matches', pattern: '/second\\.html' }],
        }),
      );

      expect(output.status).toBe('completed');
      expect(output.stoppedBeforeIndex).toBeUndefined();
      expect(output.stopReason).toBeUndefined();
      expect(output.actionReceipts.at(-1)).toMatchObject({
        op: 'click',
        status: 'completed',
        effectsCommitted: true,
      });
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([true]);
      expect(output.changes.navigated).toBe(true);
      expect(output.currentPage.url).toContain('/second.html');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'returns failed_check with committed effects when the success check does not pass',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
            { op: 'click', target: element(observation, 'button', 'Save draft') },
          ],
          successChecks: [
            { type: 'text_present', text: 'Draft saved for Grace Hopper' },
          ],
          settle: { successCheckTimeoutMs: 500 },
        }),
      );

      expect(output.status).toBe('failed_check');
      expect(output.checks.map((outcome) => outcome.passed)).toEqual([false]);
      // Nothing was rolled back, and the receipts say so.
      expect(output.actionReceipts.every((receipt) => receipt.effectsCommitted)).toBe(
        true,
      );
      expect(await pageText()).toContain('Draft saved for Ada Lovelace');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'keeps earlier effects and reports a target destroyed mid-sequence as stale',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Full name'),
              text: 'Ada Lovelace',
            },
            { op: 'click', target: element(observation, 'button', 'Remove email field') },
            {
              op: 'fill',
              target: element(observation, 'textbox', 'Email address'),
              text: 'ada@example.test',
            },
          ],
        }),
      );

      expect(output.status).toBe('stale');
      expect(
        output.actionReceipts.map((receipt) => [receipt.status, receipt.effectsCommitted]),
      ).toEqual([
        ['completed', true],
        ['completed', true],
        ['stale', false],
      ]);
      expect(output.actionReceipts.at(-1)?.error).toContain('observe the page again');
      // Partially committed: the earlier fill and click stand.
      const text = await pageText();
      expect(text).toContain('Name echo: Ada Lovelace');
      expect(text).toContain('Removed the email field');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'stops at an unexpected popup and returns views when it has no diff baseline',
    async () => {
      const observation = await openFixture();

      const output = await act({
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        // No baseline on purpose: the diff can carry nothing, so the result
        // must fall back to bounded views instead of looking unchanged.
        actions: [
          { op: 'click', target: element(observation, 'link', 'Open action popup') },
          { op: 'click', target: element(observation, 'button', 'Save draft') },
        ],
      });

      expect(output.status).toBe('partial');
      expect(output.stopReason).toBe('popup');
      expect(output.stoppedBeforeIndex).toBe(1);
      expect(output.actionReceipts).toHaveLength(1);
      expect(output.openedPages).toHaveLength(1);
      expect(output.changes.basis).toBe('full_snapshot');
      expect(output.views?.[0]?.need).toBe('interactive');
      expect(output.views?.[0]?.content).toContain('button "Save draft"');
      // The second click never ran: the draft is still unsaved.
      expect(await pageText()).toContain('No draft saved');

      // There is no longer a switch_page to move the selected pointer onto
      // the popup, and closeTab() only ever closes the task tab newTab()
      // opened — a popup can never become that page. So rather than
      // switching to the popup to close it, address it directly by its own
      // pageId to confirm it is exactly the page browser_action reported,
      // and leave it open: later tests navigate and observe the task tab by
      // its own pageId, which an unrelated open popup does not affect, and
      // the whole session (every page it owns) is torn down at suite end.
      const popupId = output.openedPages[0]?.pageId ?? '';
      const livePages = await suite.controller().pages();
      expect(livePages.some((page) => page.pageId === popupId)).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'reports settled: false for a page that never stops mutating',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'click',
              target: element(observation, 'button', 'Start restless updates'),
            },
          ],
          settle: { quietWindowMs: 250, settleTimeoutMs: 400 },
        }),
      );

      expect(output.status).toBe('completed');
      expect(output.actionReceipts[0]?.effectsCommitted).toBe(true);
      // Unsettled is a reported fact about the page, never a failure.
      expect(output.settled).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'classifies a login wall as blocked rather than a mechanical failure',
    async () => {
      const observation = await openFixture();

      const output = await act(
        requestFor(observation, {
          actions: [{ op: 'navigate', url: suite.server().url('/login.html') }],
        }),
      );

      expect(output.status).toBe('blocked');
      expect(output.blockedReason).toBe('login');
      // No server-declared delay, so none is invented.
      expect(output.retryAfterMs).toBeUndefined();
      expect(output.actionReceipts[0]).toMatchObject({
        op: 'navigate',
        status: 'completed',
        effectsCommitted: true,
      });
      expect(output.currentPage.url).toContain('/login.html');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to upload a file from outside the run directory, executing nothing',
    async () => {
      const observation = await openFixture();
      const target = element(observation, 'button', 'Attachment file');

      for (const runPath of ['../escape.txt', '/etc/hosts', 'nested/../../escape.txt']) {
        const output = await act(
          requestFor(observation, {
            actions: [
              {
                op: 'fill',
                target: element(observation, 'textbox', 'Full name'),
                text: 'Ada Lovelace',
              },
              { op: 'upload', target, runPath },
            ],
          }),
        );

        expect(output.status).toBe('failed');
        // Rejected in pre-flight: even the legal first action never ran.
        expect(output.actionReceipts).toEqual([]);
        expect(output.stoppedBeforeIndex).toBe(0);
        expect(output.error).toMatch(/escapes the run directory|must be relative/);
      }

      const text = await pageText();
      expect(text).toContain('Name echo: (empty)');
      expect(text).toContain('Attachment: (none)');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'uploads a file that lives inside the run directory',
    async () => {
      const observation = await openFixture();
      mkdirSync(join(suite.runDir(), 'artifacts'), { recursive: true });
      writeFileSync(join(suite.runDir(), 'artifacts', 'exhibit.txt'), 'exhibit bytes\n');

      const output = await act(
        requestFor(observation, {
          actions: [
            {
              op: 'upload',
              target: element(observation, 'button', 'Attachment file'),
              runPath: 'artifacts/exhibit.txt',
            },
          ],
        }),
      );

      expect(output.status).toBe('completed');
      expect(output.actionReceipts[0]).toMatchObject({
        op: 'upload',
        effectsCommitted: true,
      });
      expect(await pageText()).toContain('Attachment: exhibit.txt');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects malformed sequences before touching the browser',
    async () => {
      const observation = await openFixture();
      const target = element(observation, 'button', 'Save draft');

      const malformed: unknown[] = [
        { actions: [] },
        {
          actions: Array.from({ length: 9 }, () => ({ op: 'click', target })),
        },
        { actions: [{ op: 'teleport', target }] },
        { actions: [{ op: 'click', target: { ...target, unexpected: true } }] },
        { actions: [{ op: 'click' }] },
        { actions: [{ op: 'navigate', url: 'file:///etc/hosts' }] },
        { actions: [{ op: 'click', target }], settle: { quietWindowMs: 60_000 } },
        { actions: [{ op: 'click', target }], unexpected: true },
      ];
      for (const input of malformed) {
        const result = await call('browser_action', input);
        expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
      }

      expect(await pageText()).toContain('No draft saved');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  describe('getAccess', () => {
    function access(input: Partial<BrowserActionInput> & { actions: BrowserActionInput['actions'] }) {
      return browserActionTool.getAccess!(input as BrowserActionInput);
    }

    it('declares a page write and an observation write keyed by the acted-on page, defaulting to "selected"', () => {
      expect(access({ actions: [{ op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } }] })).toEqual({
        reads: [],
        writes: [accessKey.page('selected'), accessKey.observation('selected')],
      });
      expect(
        access({
          pageId: 'p1',
          actions: [{ op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } }],
        }),
      ).toEqual({
        reads: [],
        writes: [accessKey.page('p1'), accessKey.observation('p1')],
      });
    });

    it('reads the uploaded file, so it serializes behind a concurrent write to that exact path', () => {
      expect(
        access({
          actions: [
            {
              op: 'upload',
              target: {
                id: 'e1',
                pageId: 'p1',
                frameId: 'f1',
                documentId: 'd1',
                role: 'button',
                name: 'Attach',
              },
              runPath: 'artifacts/exhibit.txt',
            },
          ],
        }),
      ).toEqual({
        reads: [accessKey.file('artifacts/exhibit.txt')],
        writes: [accessKey.page('selected'), accessKey.observation('selected')],
      });
    });

    it('two calls on DIFFERENT pages do not conflict — the exact parallelism ToolAccess is documented for', () => {
      const onP1 = browserActionTool.getAccess!({
        pageId: 'p1',
        actions: [{ op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } }],
      } as BrowserActionInput);
      const onP2 = browserActionTool.getAccess!({
        pageId: 'p2',
        actions: [{ op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } }],
      } as BrowserActionInput);
      expect(accessesConflict(onP1, onP2)).toBe(false);
    });

    it('two calls on the SAME page conflict', () => {
      const first = browserActionTool.getAccess!({
        pageId: 'p1',
        actions: [{ op: 'scroll', direction: 'down', amount: { unit: 'viewport', value: 1 } }],
      } as BrowserActionInput);
      const second = browserActionTool.getAccess!({
        pageId: 'p1',
        actions: [{ op: 'hover', target: { id: 'e1', pageId: 'p1', frameId: 'f1', documentId: 'd1', role: 'link', name: 'x' } }],
      } as BrowserActionInput);
      expect(accessesConflict(first, second)).toBe(true);
    });
  });
});
