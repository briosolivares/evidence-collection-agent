import { z } from 'zod';

import { checklistTaskIdSchema, getChecklistTask } from '../../run/checklist.js';
import type { ToolDef } from '../registry.js';

const taskGetInputSchema = z.strictObject({
  taskId: checklistTaskIdSchema
    .describe('The positive decimal ID of the checklist task to inspect'),
});

type TaskGetInput = z.infer<typeof taskGetInputSchema>;

/** Read the complete current state of one run-scoped checklist task. */
export const taskGetTool: ToolDef<TaskGetInput> = {
  name: 'TaskGet',
  description:
    'Fetches the complete current checklist task, including its status, activeForm, and metadata. ' +
    'Use this before changing an older task. A missing task is reported without failing the run.',
  inputSchema: taskGetInputSchema,
  readOnly: true,
  execute(input, ctx) {
    const task = getChecklistTask(ctx.runDir, input.taskId);
    return task === undefined
      ? `Task #${input.taskId} not found.`
      : JSON.stringify(task, null, 2);
  },
};
