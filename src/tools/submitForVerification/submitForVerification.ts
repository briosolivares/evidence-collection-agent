import { z } from 'zod';

import { SUBMIT_FOR_VERIFICATION } from '../../completion/workerResponseProtocol.js';
import type { ApiToolDef } from '../registry.js';

// The submission control tool. It is deliberately NOT a ToolDef: it never
// runs through executeToolCall, has no executor, and touches nothing. The
// worker session intercepts it before the scheduler ever sees the response,
// because "the run is finished" is a control decision for the harness, not
// work for a tool to perform.
//
// Modelling it as a control tool rather than an ordinary one is what makes
// the exclusivity rule enforceable: there is no code path where a
// submission executes alongside a write.

// Were it ever routed through `deriveAccess`/the scheduler, the access it
// would declare is EXCLUSIVE_ACCESS. It never is: `validateWorkerResponse`
// (see workerResponseProtocol.ts) rejects any response that mixes
// `submit_for_verification` with another call, and a valid submission is
// intercepted by the worker session before `scheduleToolCalls` ever sees it,
// so no scheduling decision is made about it at all. Ending a run is the
// single most exclusive thing a call can do — nothing may be mid-flight when
// the model claims the deliverables are finished — which is exactly why the
// harness enforces it a layer earlier than the scheduler.

/** What the worker states when it submits. */
export const submitForVerificationInputSchema = z
  .object({
    /** The worker's own summary of what it produced — read by humans and
     * carried into the run's final text, never parsed for control flow. */
    summary: z.string().min(1),
    /** Limitations the worker knows about: an assumption it had to make, a
     * source that would not load, a population it could only bound. Passed
     * to the verifier, which weighs them rather than discovering them. */
    limitations: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SubmitForVerificationInput = z.infer<typeof submitForVerificationInputSchema>;

/**
 * The model-facing definition of `submit_for_verification`. Offered in the
 * API tools array like any other tool, but answered by the session rather
 * than executed.
 */
export const submitForVerificationTool: ApiToolDef = {
  name: SUBMIT_FOR_VERIFICATION,
  description:
    'Submit the finished deliverables for verification. This is the ONLY way to complete a ' +
    'run — stopping without calling it finishes nothing. It must be the only tool call in ' +
    'its response: finish any remaining work in earlier turns. Automated checks run first ' +
    '(files exist and parse, exact columns, declared counts and uniqueness, required ' +
    'sections, no leftover placeholders); if any fail you receive the list and keep ' +
    'working. Then a fresh-context verifier reviews the outputs against the contract, the ' +
    'original task, and the published evidence.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'What you produced, in one short paragraph.',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything you could not fully establish, and why — assumptions made, sources ' +
          'unavailable, populations you could only bound.',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },
};
