import { z } from 'zod';

import type { ToolAccess, ToolDef } from '../../tools/registry.js';

const nonBlankString = (maximum: number, description: string) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, {
      message: 'must contain at least one non-whitespace character',
    })
    .describe(description);

const optionSchema = z.strictObject({
  label: nonBlankString(80, 'Choice label shown to the user'),
  description: nonBlankString(
    240,
    'Optional one-line explanation of the choice',
  ).optional(),
});

export const askUserInputSchema = z.strictObject({
  question: nonBlankString(
    500,
    'One concise question for the user, written in natural language',
  ),
  context: nonBlankString(
    2_000,
    'Optional context the user needs to answer safely',
  ).optional(),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .refine(
      (options) =>
        new Set(options.map((option) => option.label.trim())).size ===
        options.length,
      { message: 'option labels must be unique' },
    )
    .optional()
    .describe('Two to four known choices; omit when free text is more appropriate'),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** Trusted answer payload merged by the existing TUI permission bridge. */
export interface AskUserAnswers {
  chosen: string[];
  freeText?: string;
}

const answersSchema = z.strictObject({
  chosen: z.array(z.string()),
  freeText: z.string().optional(),
});

export const askUserTool: ToolDef<AskUserInput> = {
  name: 'ask_user',
  description:
    'Pause and ask the user one concise question when human action or an important ' +
    'decision is required. Add only the context needed to answer safely. Supply two to ' +
    'four options when the answer space is known; otherwise allow a free-text response. ' +
    'The run fails closed with model-readable feedback when no interactive user is available.',
  inputSchema: askUserInputSchema,
  getAccess: (): ToolAccess => ({ reads: [], writes: [], exclusive: true }),
  requiresUserInteraction: true,
  execute(input) {
    const parsed = answersSchema.safeParse(
      (input as AskUserInput & { answers?: unknown }).answers,
    );
    if (!parsed.success) {
      throw new Error(
        'ask_user ran without a valid answer; it must resolve through the interactive permission gate.',
      );
    }

    const parts: string[] = [];
    if (parsed.data.chosen.length > 0) {
      parts.push(
        `User chose: ${parsed.data.chosen.map((label) => JSON.stringify(label)).join(', ')}.`,
      );
    }

    const freeText = parsed.data.freeText?.trim();
    if (freeText !== undefined && freeText !== '') {
      parts.push(`User answered: ${JSON.stringify(freeText)}`);
    }

    if (parts.length === 0) {
      return (
        'The user submitted no answer. Continue without this information ' +
        'or report the limitation and finish.'
      );
    }
    return parts.join(' ');
  },
};
