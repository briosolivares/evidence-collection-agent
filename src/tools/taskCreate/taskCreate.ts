import { z } from 'zod';

import {
  checklistTaskMetadataSchema,
  createChecklistTask,
  type ChecklistTaskMetadata,
} from '../../run/checklist.js';
import type { ToolDef } from '../registry.js';

const taskCreateInputSchema = z.strictObject({
  subject: z.string().trim().min(1).describe('A concise name for the checklist item'),
  description: z.string().trim().min(1).describe('The work required for this checklist item'),
  activeForm: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Present-continuous form shown while this item is in progress'),
  metadata: checklistTaskMetadataSchema
    .optional()
    .describe('Optional structured metadata, including expectedArtifacts'),
});

type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;

/** `TaskCreate` — create one durable, run-scoped checklist item. */
export const taskCreateTool: ToolDef<TaskCreateInput> = {
  name: 'TaskCreate',
  description:
    'Create a checklist item for non-trivial work with three or more meaningful steps. ' +
    'Skip this for straightforward tasks. Call TaskList first to avoid duplicates. ' +
    'Keep the subject concise, and mark the item ' +
    'in_progress before starting its work.',
  inputSchema: taskCreateInputSchema,
  readOnly: false,
  execute(input, ctx) {
    const task = createChecklistTask(ctx.runDir, {
      subject: input.subject,
      description: input.description,
      ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: input.metadata as ChecklistTaskMetadata }),
    });
    return `Task #${task.id} created: ${task.subject}. Mark it in_progress before starting it.`;
  },
};
