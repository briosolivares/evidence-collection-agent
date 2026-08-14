import { z } from 'zod';

import type { HandleDialogRequest } from '../../browser/controller.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';

const handleDialogInputSchema = z.strictObject({
  dialogId: z
    .string()
    .min(1)
    .describe('Dialog id from a browser_action result dialogs entry'),
  action: z
    .enum(['accept', 'dismiss'])
    .describe("'accept' presses OK; 'dismiss' presses Cancel"),
  promptText: z
    .string()
    .max(4_000)
    .optional()
    .describe('Text to submit when accepting a prompt dialog; ignored for other types'),
});

/** Input accepted by the handle_dialog tool. */
export type HandleDialogInput = z.infer<typeof handleDialogInputSchema>;

/**
 * `handle_dialog` — answer one JavaScript dialog that is blocking a page.
 *
 * Dialogs are held open rather than auto-dismissed, because dismissing a
 * `confirm` silently answers "Cancel" to a decision the task may depend on.
 * While a dialog is pending its page runs no script — no observation, no
 * action, not even a title read — so answering it is the only way forward,
 * and `browser_action` stops and reports the dialog rather than burning its
 * timeouts against a blocked renderer.
 */
export const handleDialogTool: ToolDef<HandleDialogInput> = {
  name: 'handle_dialog',
  description:
    'Answer a browser dialog (alert/confirm/prompt/beforeunload) reported by browser_action: accept ' +
    'or dismiss it, optionally supplying promptText for a prompt. A pending dialog blocks its page ' +
    'entirely, so answer it before observing or acting again. Returns the page after the decision and ' +
    'any dialogs still pending.',
  inputSchema: handleDialogInputSchema,
  // Addressed by dialogId, not pageId — the input has no page-scoped key to
  // name, and a pending dialog can block ANY page in the session, not
  // necessarily the currently selected one. Unable to name what it touches,
  // so exclusive.
  getAccess: () => ({ reads: [], writes: [], exclusive: true }),
  async execute(input, ctx) {
    const browser = requireBrowser(ctx);
    const request: HandleDialogRequest = {
      dialogId: input.dialogId,
      action: input.action,
      ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    };
    return browser.handleDialog(request);
  },
};
