import { z } from 'zod';

import type { ToolDef } from '../registry.js';

export const FINISH_TOOL_NAME = 'finish' as const;

const nonBlankString = (maximum: number, description: string) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, {
      message: 'must contain at least one non-whitespace character',
    })
    .describe(description);

export const finishUnresolvedRequirementSchema = z.strictObject({
  requirement: nonBlankString(2_000, 'The specific explicit requirement that remains unresolved'),
  reason: nonBlankString(4_000, 'Why the requirement could not be completed'),
  attempts: z
    .array(
      nonBlankString(2_000, 'A source, action, or approach already tried for this requirement'),
    )
    .max(20),
});

export type FinishUnresolvedRequirement = z.infer<typeof finishUnresolvedRequirementSchema>;

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
  unresolved: z
    .array(finishUnresolvedRequirementSchema)
    .max(50)
    .describe('Explicit requirements that remain unresolved; use [] when the request is complete'),
});

export type FinishInput = z.infer<typeof finishInputSchema>;

/** The finish shape embedded in durable checkpoints. */
export const durableFinishInputSchema = finishInputSchema;

/**
 * Model-facing definition for the exclusive completion control call.
 *
 * `execute` is intentionally unusable. The worker loop must recognize an
 * exclusive finish response and hand its validated input to completion checks
 * rather than allowing generic tool execution to imply success.
 */
export const finishTool: ToolDef<FinishInput> = {
  name: FINISH_TOOL_NAME,
  description:
    'Submit the work for deterministic checks and independent review. Provide the user-facing ' +
    'summary to release after review and list each explicit unresolved requirement, why it is ' +
    'blocked, and approaches already tried; use unresolved: [] when you believe the request is complete. ' +
    'Requested outputs and evidence are derived only from the authoritative manifest. ' +
    'finish must be the only tool call in its assistant response; it requests review and cannot ' +
    'declare success by itself.',
  inputSchema: finishInputSchema,
  execute() {
    throw new Error(
      'finish is a control call that must be intercepted by the worker loop; it cannot execute as an ordinary tool.',
    );
  },
};
