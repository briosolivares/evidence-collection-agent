import { z } from 'zod';

import { finishInputSchema } from '../../tools/finish/finish.js';

// The verifier's decision shape: what a report_verification call must carry,
// and the durable projections of past verification cycles built from it.
// See verifier.ts for REPORT_VERIFICATION_TOOL (the hand-authored JSON-schema
// tool definition the model actually sees) and the verifier loop that
// validates a tool call against verificationResultSchema below.

const boundedNonBlank = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');

const requirementProblemShape = {
  requirement: boundedNonBlank(4_000),
  problem: boundedNonBlank(4_000),
} as const;

/** The verifier identifies the unsupported requirement; it never prescribes
 * artifact contents. The harness attaches a fixed research instruction. */
export const researchFindingSchema = z.strictObject({
  kind: z.literal('research'),
  ...requirementProblemShape,
});

/** Permitted only when the cited, already-surfaced evidence supports the
 * repair. An "unavailable" note is never support for a synthetic row. */
export const artifactRepairFindingSchema = z.strictObject({
  kind: z.literal('artifact_repair'),
  ...requirementProblemShape,
  evidencePaths: z.array(boundedNonBlank(1_024)).min(1).max(50),
});

/** Restricted to correcting the worker's own summary/unresolved report; it
 * cannot change artifacts or erase a material blocker. */
export const reportRepairFindingSchema = z.strictObject({
  kind: z.literal('report_repair'),
  ...requirementProblemShape,
});

export const correctionFindingSchema = z.discriminatedUnion('kind', [
  researchFindingSchema,
  artifactRepairFindingSchema,
  reportRepairFindingSchema,
]);

export const incompleteFindingSchema = z.strictObject({
  requirement: boundedNonBlank(4_000),
  assessment: boundedNonBlank(4_000),
  evidencePaths: z.array(boundedNonBlank(1_024)).max(50).optional(),
});

export type CorrectionFinding = z.infer<typeof correctionFindingSchema>;
export type IncompleteFinding = z.infer<typeof incompleteFindingSchema>;

export const verificationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    findings: z.array(z.never()).max(0),
  }),
  z.strictObject({
    status: z.literal('needs_correction'),
    findings: z.array(correctionFindingSchema).min(1).max(50),
  }),
  z.strictObject({
    status: z.literal('incomplete'),
    findings: z.array(incompleteFindingSchema).min(1).max(50),
  }),
]);

export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const surfacedArtifactSchema = z.strictObject({
  filename: boundedNonBlank(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: boundedNonBlank(8_192).optional(),
  publicationKind: z.enum(['file', 'text', 'screenshot', 'download']).optional(),
  roles: z
    .array(z.enum(['requested_output', 'evidence']))
    .min(1)
    .max(2),
  capturedAt: boundedNonBlank(128),
  completionStatus: z.enum(['complete', 'partial']).optional(),
});

export type SurfacedArtifact = z.infer<typeof surfacedArtifactSchema>;

export const verificationHistoryEntrySchema = z.strictObject({
  cycle: z.number().int().positive(),
  completionReport: finishInputSchema,
  surfacedEvidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(correctionFindingSchema).min(1).max(50),
});

export type VerificationHistoryEntry = z.infer<typeof verificationHistoryEntrySchema>;
