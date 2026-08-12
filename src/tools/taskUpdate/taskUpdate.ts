import { z } from 'zod';

import {
  checklistTaskIdSchema,
  deleteChecklistTask,
  updateChecklistTask,
} from '../../run/checklist.js';
import type { ToolDef } from '../registry.js';

const taskUpdateInputSchema = z.strictObject({
  taskId: checklistTaskIdSchema
    .describe('The positive decimal ID of the checklist task to update'),
  subject: z.string().trim().min(1).optional().describe('Replacement concise task subject'),
  description: z.string().trim().min(1).optional().describe('Replacement task description'),
  activeForm: z.string().trim().min(1).optional()
    .describe('Present-continuous label shown while the task is in progress'),
  metadata: z.record(z.string(), z.unknown().nullable()).optional()
    .describe('Metadata keys to merge; use null to remove a key'),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional()
    .describe('New status, or deleted to remove the task'),
}).superRefine((input, ctx) => {
  if (
    input.subject === undefined &&
    input.description === undefined &&
    input.activeForm === undefined &&
    input.metadata === undefined &&
    input.status === undefined
  ) {
    ctx.addIssue({ code: 'custom', message: 'provide at least one field to update' });
  }
});

type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>;

/** Mutate one run-scoped checklist task, or delete it with status: deleted. */
export const taskUpdateTool: ToolDef<TaskUpdateInput> = {
  name: 'TaskUpdate',
  description:
    'Updates only the named checklist task. Mark it in_progress before work and completed immediately ' +
    'after implementation, evidence, tests, and promised artifacts are done. Keep it open after errors ' +
    'or partial work; use status deleted only for mistakes or superseded items. Metadata merges by key, ' +
    'and null removes a key.',
  inputSchema: taskUpdateInputSchema,
  readOnly: false,
  execute(input, ctx) {
    if (input.status === 'deleted') {
      if (!deleteChecklistTask(ctx.runDir, input.taskId)) {
        throw new Error(`Checklist task #${input.taskId} was not found`);
      }
      return `Task #${input.taskId} deleted.`;
    }

    const task = updateChecklistTask(ctx.runDir, input.taskId, {
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return input.status === 'completed'
      ? `Task #${task.id} completed. Call TaskList now; do not batch task completions.`
      : `Task #${task.id} updated. Keep the checklist current as work proceeds.`;
  },
};
