import { z } from 'zod';

/** One objective defect the worker can repair before a verifier is called. */
export interface V3FinishDefect {
  /** Stable programmatic identifier. */
  code: string;
  /** Direct correction guidance suitable for a `finish` tool result. */
  message: string;
  /** Contract output affected by the defect, when applicable. */
  outputId?: string;
  /** Run-relative artifact involved in the defect, when applicable. */
  artifactPath?: string;
}

/** Structural verifier fact; compatible with the preserved verifier seam. */
export interface V3SettledFact {
  outputId?: string;
  code: string;
  statement: string;
}

const v3TableFactSchema = z.strictObject({
  kind: z.literal('table'),
  outputId: z.string(),
  artifactPath: z.string(),
  format: z.enum(['csv', 'json', 'markdown']),
  columns: z.array(z.string()),
  rowCount: z.number().int().nonnegative(),
  satisfiedRules: z.array(
    z.enum([
      'exact_row_count',
      'minimum_row_count',
      'unique',
      'matches_expected_values',
    ]),
  ),
});

const v3DocumentFactSchema = z.strictObject({
  kind: z.literal('document'),
  outputId: z.string(),
  artifactPath: z.string(),
  format: z.enum(['markdown', 'text', 'pdf']),
  byteLength: z.number().int().nonnegative(),
  requiredSectionsPresent: z.array(z.string()),
});

const v3CaptureFactSchema = z.strictObject({
  kind: z.enum(['screenshots', 'download']),
  outputId: z.string(),
  artifactPaths: z.array(z.string()),
  count: z.number().int().nonnegative(),
  filenamePattern: z.string().optional(),
  inferredMediaTypes: z.array(z.array(z.string())),
  sourceUrls: z.array(z.string()),
});

/** Strict checkpoint validator for the code-settled verifier payload. */
export const v3FinishFactsSchema = z.strictObject({
  finish: z.strictObject({
    summary: z.string(),
    artifactPaths: z.array(z.string()),
    limitations: z.array(z.string()),
  }),
  manifest: z
    .strictObject({
      task: z.string(),
      browserProvider: z.enum(['local', 'browserbase']).optional(),
      entryCount: z.number().int().nonnegative(),
      verifiedPaths: z.array(z.string()),
      requestedOutputPaths: z.array(z.string()),
      evidencePaths: z.array(z.string()),
    })
    .optional(),
  outputs: z.array(
    z.discriminatedUnion('kind', [
      v3TableFactSchema,
      v3DocumentFactSchema,
      v3CaptureFactSchema,
    ]),
  ),
  evidenceScreenshotPaths: z.array(z.string()),
});

export type V3TableFact = z.infer<typeof v3TableFactSchema>;
export type V3DocumentFact = z.infer<typeof v3DocumentFactSchema>;
export type V3CaptureFact = z.infer<typeof v3CaptureFactSchema>;
export type V3OutputFact = V3TableFact | V3DocumentFact | V3CaptureFact;
export type V3FinishFacts = z.infer<typeof v3FinishFactsSchema>;
export type V3ManifestFacts = NonNullable<V3FinishFacts['manifest']>;

export type V3FinishCheckResult =
  | {
      status: 'passed';
      defects: [];
      facts: V3FinishFacts;
    }
  | {
      status: 'failed';
      defects: [V3FinishDefect, ...V3FinishDefect[]];
      /** Partial positive facts are retained so diagnostics remain auditable. */
      facts: V3FinishFacts;
    };
