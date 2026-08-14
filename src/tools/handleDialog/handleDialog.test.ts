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
import type { HandleDialogResult } from '../../browser/controller.js';
import { browserActionTool } from '../browserAction/browserAction.js';
import { observeTool } from '../observe/observe.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { handleDialogTool } from './handleDialog.js';

describe('handle_dialog tool', () => {
  const suite = setupBrowserToolSuite('handle-dialog-tool');
  const registry = createRegistry([observeTool, browserActionTool, handleDialogTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  async function openFixture(): Promise<BrowserObservation> {
    await call('browser_action', {
      actions: [{ op: 'navigate', url: suite.server().url('/actions.html') }],
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
      throw new Error(`No observed ${role} "${name}" on the fixture page.`);
    }
    return match;
  }

  /** Click the named button and return the sequence result. The click's own
   * promise cannot resolve while the dialog is open, so this also proves the
   * sequence escapes instead of burning the action timeout. */
  async function clickAndCatchDialog(
    observation: BrowserObservation,
    buttonName: string,
  ): Promise<BrowserActionOutput> {
    const result = await call('browser_action', {
      pageId: observation.page.pageId,
      documentId: observation.page.documentId,
      basedOnObservationId: observation.page.observationId,
      actions: [{ op: 'click', target: element(observation, 'button', buttonName) }],
    });
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as BrowserActionOutput;
  }

  async function handle(input: unknown): Promise<HandleDialogResult> {
    const result = await call('handle_dialog', input);
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as HandleDialogResult;
  }

  /** Only safe once no dialog is pending: a pending dialog blocks the
   * renderer, so observing would wait for a decision nobody made. */
  async function pageText(): Promise<string> {
    const result = await call('observe', { need: ['text'] });
    expect(result.isError).toBe(false);
    const observation = JSON.parse(result.content) as BrowserObservation;
    return observation.views[0]?.content ?? '';
  }

  it(
    'reports a confirm dialog with committed effects and applies an accept',
    async () => {
      const observation = await openFixture();

      const output = await clickAndCatchDialog(observation, 'Ask to delete draft');

      expect(output.status).toBe('completed');
      // The click's handler ran — that is what raised the dialog.
      expect(output.actionReceipts[0]).toMatchObject({
        op: 'click',
        status: 'completed',
        effectsCommitted: true,
      });
      expect(output.dialogs).toHaveLength(1);
      expect(output.dialogs[0]).toMatchObject({
        pageId: observation.page.pageId,
        type: 'confirm',
        message: 'Delete the draft?',
      });
      // A blocked renderer cannot be observed or even asked for its title.
      expect(output.settled).toBe(false);
      expect(output.changes).toMatchObject({ basis: 'full_snapshot', navigated: false });
      expect(output.currentPage.title).toBe('');
      expect(output.note).toContain('handle_dialog');

      const dialogId = output.dialogs[0]?.dialogId ?? '';
      const handled = await handle({ dialogId, action: 'accept' });
      expect(handled).toMatchObject({ dialogId, handled: 'accepted' });
      expect(handled.pendingDialogs).toEqual([]);
      expect(handled.page?.title).toBe('Browser Action Fixture');

      expect(await pageText()).toContain('Draft deleted');

      // The same id cannot be answered twice.
      const again = await call('handle_dialog', { dialogId, action: 'accept' });
      expect(again).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(again.content).toContain('No browser dialog is pending');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'stops a sequence at the dialog and never runs the actions behind it',
    async () => {
      const observation = await openFixture();

      const result = await call('browser_action', {
        pageId: observation.page.pageId,
        documentId: observation.page.documentId,
        basedOnObservationId: observation.page.observationId,
        actions: [
          { op: 'click', target: element(observation, 'button', 'Ask to delete draft') },
          {
            op: 'fill',
            target: element(observation, 'textbox', 'Full name'),
            text: 'Ada Lovelace',
          },
        ],
      });
      expect(result.isError).toBe(false);
      const output = JSON.parse(result.content) as BrowserActionOutput;

      expect(output.status).toBe('partial');
      expect(output.stopReason).toBe('dialog');
      expect(output.stoppedBeforeIndex).toBe(1);
      expect(output.actionReceipts).toHaveLength(1);
      expect(output.dialogs).toHaveLength(1);

      await handle({
        dialogId: output.dialogs[0]?.dialogId ?? '',
        action: 'dismiss',
      });
      const text = await pageText();
      expect(text).toContain('Kept the draft');
      // The fill behind the dialog was named, not performed.
      expect(text).toContain('Name echo: (empty)');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'dismisses a confirm dialog as an explicit Cancel',
    async () => {
      const observation = await openFixture();

      const output = await clickAndCatchDialog(observation, 'Ask to delete draft');
      const dialogId = output.dialogs[0]?.dialogId ?? '';
      const handled = await handle({ dialogId, action: 'dismiss' });

      expect(handled.handled).toBe('dismissed');
      expect(await pageText()).toContain('Kept the draft');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'submits prompt text and reports the dialog default value',
    async () => {
      const observation = await openFixture();

      const output = await clickAndCatchDialog(observation, 'Ask for draft label');
      expect(output.dialogs[0]).toMatchObject({
        type: 'prompt',
        message: 'Label this draft',
        defaultValue: 'draft-1',
      });

      await handle({
        dialogId: output.dialogs[0]?.dialogId ?? '',
        action: 'accept',
        promptText: 'quarterly-controls',
      });

      expect(await pageText()).toContain('Labeled quarterly-controls');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects unknown ids and malformed input',
    async () => {
      await openFixture();

      const unknown = await call('handle_dialog', {
        dialogId: 'dialog-404',
        action: 'accept',
      });
      expect(unknown).toMatchObject({ isError: true, errorKind: 'execution_error' });
      expect(unknown.content).toContain('No browser dialog is pending');

      for (const input of [
        {},
        { dialogId: 'dialog-1' },
        { dialogId: 'dialog-1', action: 'ignore' },
        { dialogId: '', action: 'accept' },
        { dialogId: 'dialog-1', action: 'accept', extra: true },
      ]) {
        const result = await call('handle_dialog', input);
        expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
