import { z } from 'zod';

import type { ToolDef } from '../../tools/registry.js';

export const FINISH_TOOL_NAME = 'finish' as const;

const nonBlankString = (maximum: number, description: string) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, {
      message: 'must contain at least one non-whitespace character',
    })
    .describe(description);

const uniqueNonBlankStrings = (
  maximumItems: number,
  itemMaximum: number,
  description: string,
) =>
  z
    .array(nonBlankString(itemMaximum, description))
    .max(maximumItems)
    .superRefine((values, ctx) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: 'must not contain duplicate values',
          });
        }
        seen.add(value);
      }
    });

/**
 * Completion request produced by the worker. The loop validates this strict
 * object and intercepts it before ordinary tool dispatch; deterministic
 * output checks and verification own the actual completion decision.
 */
export const finishInputSchema = z.strictObject({
  summary: nonBlankString(
    8_000,
    'User-facing summary of the completed work and what each output contains',
  ),
});

export type FinishInput = z.infer<typeof finishInputSchema>;

/**
 * Read compatibility for checkpoints written before requested outputs became
 * manifest-derived. This schema is never exposed to the model-facing API.
 */
export const legacyFinishInputSchema = z.strictObject({
  summary: finishInputSchema.shape.summary,
  artifacts: uniqueNonBlankStrings(
    100,
    1_024,
    'Legacy run-relative requested-output path',
  ).optional(),
  limitations: uniqueNonBlankStrings(
    100,
    2_000,
    'Legacy unresolved source, access, or freshness limitation',
  ),
});

/** Read old v3 checkpoint cargo, but expose and rewrite only the current shape. */
export const durableFinishInputSchema = z
  .union([finishInputSchema, legacyFinishInputSchema])
  .transform((finish): FinishInput => ({ summary: finish.summary }));

/**
 * Model-facing definition for the exclusive completion control call.
 *
 * `execute` is intentionally unusable. The v3 worker loop must recognize an
 * exclusive finish response and hand its validated input to completion checks
 * rather than allowing generic tool execution to imply success.
 */
export const finishTool: ToolDef<FinishInput> = {
  name: FINISH_TOOL_NAME,
  description:
    'Request deterministic checks and independent verification after every requested output ' +
    'has been published and inspected. Provide a user-facing summary of the completed work and ' +
    'outputs. Requested outputs and evidence are derived from the authoritative manifest. ' +
    'finish must be the only tool call in its assistant response; it requests review and cannot ' +
    'declare success by itself.',
  inputSchema: finishInputSchema,
  getAccess: () => ({ reads: [], writes: [], exclusive: true }),
  execute() {
    throw new Error(
      'finish is a control call that must be intercepted by the v3 worker loop; it cannot execute as an ordinary tool.',
    );
  },
};
