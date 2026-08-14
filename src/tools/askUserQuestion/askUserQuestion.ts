import { z } from 'zod';

import type { ToolAccess, ToolDef } from '../registry.js';

const optionSchema = z.strictObject({
  label: z.string().min(1).describe('The choice as shown to the user'),
  description: z
    .string()
    .optional()
    .describe('One-line explanation of what choosing this means'),
});

const askUserQuestionInputSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .describe('The complete question for the user, in natural language'),
  header: z
    .string()
    .min(1)
    .max(12)
    .optional()
    .describe('Very short label for the dialog chip, e.g. "Login"'),
  options: z
    .array(optionSchema)
    .max(4)
    .optional()
    .describe('Predefined choices; the user can always answer in free text instead'),
  multi_select: z
    .boolean()
    .optional()
    .describe('Allow the user to choose several options'),
});

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;

/** What the dialog merges into the allowed input. Trusted UI data — never
 * part of the model-facing schema. */
export interface AskUserAnswers {
  /** Labels of the options the user selected (empty when they only typed). */
  chosen: string[];
  /** The user's free-text reply, when they typed one. */
  freeText?: string;
}

/**
 * `ask_user_question` — pause the run and put one question to the human.
 *
 * The permission gate doubles as the answer channel: the TUI dialog renders
 * the question, the user picks options and/or types, and the dialog resolves
 * allow with `answers` merged into the input. `execute` therefore does no
 * I/O — it turns the trusted answers into plain prose, because the model
 * resumes mid-conversation and should treat the result exactly like a user
 * turn (nothing pattern-matches for "done"; the model interprets the reply).
 * In environments with nobody to ask, the gate fails closed before execute.
 */
export const askUserQuestionTool: ToolDef<AskUserQuestionInput> = {
  name: 'ask_user_question',
  description:
    'Asks the user one question and pauses the task until they answer, e.g. ' +
    'when login needs a human (a code, a CAPTCHA, "sign in with…") or ' +
    'something important is ambiguous. Provide up to 4 options when the ' +
    'answer space is known; the user can always reply in free text. While ' +
    'paused, the user may also act directly in the browser window.',
  inputSchema: askUserQuestionInputSchema,
  // Pauses the ENTIRE run for a human, for however long they take to
  // answer. Nothing else may be mid-flight while that wait is open: a
  // concurrent call could finish and mutate state the user cannot see
  // while deciding, or the user's eventual answer could steer a decision
  // the concurrent call has already acted on. It cannot name a narrower
  // key than "everything" — the whole point is that the run itself is
  // paused, not any one resource.
  getAccess: (): ToolAccess => ({ reads: [], writes: [], exclusive: true }),
  requiresUserInteraction: true,
  execute(input) {
    const answers = (input as { answers?: AskUserAnswers }).answers;
    if (answers === undefined) {
      throw new Error(
        'ask_user_question ran without answers; it must be resolved through ' +
          'the interactive permission gate.',
      );
    }

    const parts: string[] = [];
    if (answers.chosen.length > 0) {
      parts.push(
        `User chose: ${answers.chosen.map((label) => `"${label}"`).join(', ')}.`,
      );
    }
    const freeText = answers.freeText?.trim();
    if (freeText !== undefined && freeText !== '') {
      parts.push(`User answered: "${freeText}"`);
    }
    if (parts.length === 0) {
      return (
        'The user submitted no answer. Continue without this information ' +
        'or finish the task.'
      );
    }
    return parts.join(' ');
  },
};
