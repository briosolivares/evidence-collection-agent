import { z } from 'zod';

import { listChecklistTasks } from '../../run/checklist.js';
import type { ToolDef } from '../registry.js';

const taskListInputSchema = z.strictObject({});
type TaskListInput = z.infer<typeof taskListInputSchema>;

/** `TaskList` — inspect the current run's checklist (read-only). */
export const taskListTool: ToolDef<TaskListInput> = {
  name: 'TaskList',
  description:
    'Review the current checklist. Call this after completing an item and before finalizing ' +
    'a non-trivial run; it returns all tasks in numeric order.',
  inputSchema: taskListInputSchema,
  readOnly: true,
  execute(_input, ctx) {
    const tasks = listChecklistTasks(ctx.runDir);
    if (tasks.length === 0) return 'No checklist tasks found';
    return tasks.map((task) => `#${task.id} [${task.status}] ${task.subject}`).join('\n');
  },
};
