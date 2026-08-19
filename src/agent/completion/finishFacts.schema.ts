import { z } from 'zod';

import { durableFinishInputSchema } from '../../tools/finish/finish.js';

/** Durable structural finding produced by deterministic finish inspection. */
export const v3FinishDefectSchema = z.strictObject({
  /** Stable programmatic identifier. */
  code: z.string(),
  /** Concrete structural observation and correction guidance. */
  message: z.string(),
  /** Contract output affected by the finding, when applicable. */
  outputId: z.string().optional(),
  /** Run-relative artifact involved in the finding, when applicable. */
  artifactPath: z.string().optional(),
});

export type V3FinishDefect = z.infer<typeof v3FinishDefectSchema>;

/** Structural verifier fact; compatible with the preserved verifier seam. */
export interface V3SettledFact {
  outputId?: string;
  code: string;
  statement: string;
}

/** Per-declared-column nonblank cell count, purely informational: it carries
 * no threshold and never becomes a deterministic defect on its own. */
const v3ColumnNonblankCountSchema = z.strictObject({
  column: z.string(),
  nonblankCount: z.number().int().nonnegative(),
});

const v3TableFactSchema = z.strictObject({
  kind: z.literal('table'),
  outputId: z.string(),
  artifactPath: z.string(),
  format: z.enum(['csv', 'json', 'markdown']),
  columns: z.array(z.string()),
  rowCount: z.number().int().nonnegative(),
  /** One entry per declared column, in contract order. Optional so
   * checkpoints written before this field existed still parse. */
  columnNonblankCounts: z.array(v3ColumnNonblankCountSchema).optional(),
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

const v3ExternalActionFactSchema = z.strictObject({
  kind: z.literal('external_action'),
  outputId: z.string(),
  sourceUrlPattern: z.string(),
  /** Verified artifacts whose recorded source URL matches the destination. */
  proofPaths: z.array(z.string()),
  /** Valid PNG proof screenshots among proofPaths. */
  screenshotCount: z.number().int().nonnegative(),
  sourceUrls: z.array(z.string()),
});

/** Strict checkpoint validator for the code-settled verifier payload. */
export const v3FinishFactsSchema = z.strictObject({
  finish: durableFinishInputSchema,
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
      v3ExternalActionFactSchema,
    ]),
  ),
  evidenceScreenshotPaths: z.array(z.string()),
});

export type V3ColumnNonblankCount = z.infer<typeof v3ColumnNonblankCountSchema>;
export type V3TableFact = z.infer<typeof v3TableFactSchema>;
export type V3DocumentFact = z.infer<typeof v3DocumentFactSchema>;
export type V3CaptureFact = z.infer<typeof v3CaptureFactSchema>;
export type V3ExternalActionFact = z.infer<typeof v3ExternalActionFactSchema>;
export type V3OutputFact =
  | V3TableFact
  | V3DocumentFact
  | V3CaptureFact
  | V3ExternalActionFact;
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
