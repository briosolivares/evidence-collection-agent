import { z } from 'zod';

import { clickTool } from '../click/click.js';
import { downloadTool } from '../download/download.js';
import { inspectPageTool } from '../inspectPage/inspectPage.js';
import { navigateTool } from '../navigate/navigate.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolDef } from '../registry.js';
import { screenshotTool } from '../screenshot/screenshot.js';
import { scrollTool } from '../scroll/scroll.js';
import { typeTool } from '../type/type.js';

const batchableBrowserTools = [
  navigateTool,
  inspectPageTool,
  clickTool,
  typeTool,
  scrollTool,
  screenshotTool,
  downloadTool,
] as const;

const batchableBrowserRegistry = createRegistry(batchableBrowserTools);

const browserBatchActionSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('navigate'),
    input: navigateTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('inspect_page'),
    input: inspectPageTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('click'),
    input: clickTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('type'),
    input: typeTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('scroll'),
    input: scrollTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('screenshot'),
    input: screenshotTool.inputSchema,
  }),
  z.strictObject({
    tool: z.literal('download'),
    input: downloadTool.inputSchema,
  }),
]);

const browserBatchInputSchema = z.strictObject({
  actions: z
    .array(browserBatchActionSchema)
    .min(1, 'Include at least one browser action')
    .max(10, 'A browser batch may contain at most 10 actions'),
});

/** One validated atomic browser operation inside a batch. */
export type BrowserBatchAction = z.infer<typeof browserBatchActionSchema>;

/** Input accepted by the browser_batch tool. */
export type BrowserBatchInput = z.infer<typeof browserBatchInputSchema>;

/** One nested atomic result, in the same position as its requested action. */
export interface BrowserBatchActionResult {
  index: number;
  tool: BrowserBatchAction['tool'];
  content: string;
}

/** Successful model-visible result from browser_batch. */
export interface BrowserBatchResult {
  status: 'completed';
  results: BrowserBatchActionResult[];
}

/**
 * Execute known browser operations in order through their normal tool
 * pipelines. A failure stops the sequence because later actions commonly
 * depend on browser state established by earlier ones; completed effects are
 * deliberately not rolled back.
 */
export const browserBatchTool: ToolDef<BrowserBatchInput> = {
  name: 'browser_batch',
  description:
    'Execute 1–10 known browser operations sequentially in one call. Each action uses ' +
    'an existing browser tool and its normal input. Use this when all inputs are already ' +
    'known, often ending with inspect_page to observe the final state. Refs must come ' +
    'from a prior model-visible inspect_page and remain valid until used. Stops on the ' +
    'first error without rolling back completed actions.',
  inputSchema: browserBatchInputSchema,
  readOnly: false,
  async execute(input, ctx): Promise<BrowserBatchResult> {
    const results: BrowserBatchActionResult[] = [];

    for (const [index, action] of input.actions.entries()) {
      const result = await executeToolCall(
        batchableBrowserRegistry,
        {
          id: `browser_batch-${index + 1}`,
          name: action.tool,
          input: action.input,
        },
        ctx,
      );

      if (result.isError) {
        const completed = results.length;
        const completedLabel = completed === 1 ? 'action' : 'actions';
        throw new Error(
          `Batch stopped at action ${index + 1}/${input.actions.length} ` +
            `(${action.tool}) after ${completed} completed ${completedLabel}: ` +
            `${result.content} Completed actions were not rolled back.`,
        );
      }

      results.push({ index, tool: action.tool, content: result.content });
    }

    return { status: 'completed', results };
  },
};
