import { z } from 'zod';

import { browserProviderKindSchema } from '../../browser/sessionProvider.js';
import { durableFinishInputSchema } from '../../tools/finish/finish.js';

/** Durable structural finding produced by deterministic finish inspection. */
export const finishDefectSchema = z.strictObject({
  /** Stable programmatic identifier. */
  code: z.string(),
  /** Concrete structural observation and correction guidance. */
  message: z.string(),
  /** Contract output affected by the finding, when applicable. */
  outputId: z.string().optional(),
  /** Run-relative artifact involved in the finding, when applicable. */
  artifactPath: z.string().optional(),
});

export type FinishDefect = z.infer<typeof finishDefectSchema>;

/** Structural verifier fact; compatible with the preserved verifier seam. */
export interface SettledFact {
  outputId?: string;
  code: string;
  statement: string;
}

/** Per-declared-column nonblank cell count, purely informational: it carries
 * no threshold and never becomes a deterministic defect on its own. */
const columnNonblankCountSchema = z.strictObject({
  column: z.string(),
  nonblankCount: z.number().int().nonnegative(),
});

const tableFactSchema = z.strictObject({
  kind: z.literal('table'),
  outputId: z.string(),
  artifactPath: z.string(),
  format: z.enum(['csv', 'json', 'markdown']),
  columns: z.array(z.string()),
  rowCount: z.number().int().nonnegative(),
  /** One entry per declared column, in contract order. */
  columnNonblankCounts: z.array(columnNonblankCountSchema),
  satisfiedRules: z.array(z.enum(['exact_row_count', 'minimum_row_count', 'unique'])),
});

const documentFactSchema = z.strictObject({
  kind: z.literal('document'),
  outputId: z.string(),
  artifactPath: z.string(),
  format: z.enum(['markdown', 'text', 'pdf']),
  byteLength: z.number().int().nonnegative(),
  requiredSectionsPresent: z.array(z.string()),
});

const captureFactSchema = z.strictObject({
  kind: z.enum(['screenshots', 'download']),
  outputId: z.string(),
  artifactPaths: z.array(z.string()),
  count: z.number().int().nonnegative(),
  filenamePattern: z.string().optional(),
  inferredMediaTypes: z.array(z.array(z.string())),
  sourceUrls: z.array(z.string()),
});

const externalActionFactSchema = z.strictObject({
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
export const finishFactsSchema = z.strictObject({
  finish: durableFinishInputSchema,
  manifest: z
    .strictObject({
      task: z.string(),
      browserProvider: browserProviderKindSchema.optional(),
      entryCount: z.number().int().nonnegative(),
      verifiedPaths: z.array(z.string()),
      requestedOutputPaths: z.array(z.string()),
      evidencePaths: z.array(z.string()),
    })
    .optional(),
  outputs: z.array(
    z.discriminatedUnion('kind', [
      tableFactSchema,
      documentFactSchema,
      captureFactSchema,
      externalActionFactSchema,
    ]),
  ),
  evidenceScreenshotPaths: z.array(z.string()),
});

export type ColumnNonblankCount = z.infer<typeof columnNonblankCountSchema>;
export type TableFact = z.infer<typeof tableFactSchema>;
export type DocumentFact = z.infer<typeof documentFactSchema>;
export type CaptureFact = z.infer<typeof captureFactSchema>;
export type ExternalActionFact = z.infer<typeof externalActionFactSchema>;
export type OutputFact = TableFact | DocumentFact | CaptureFact | ExternalActionFact;
export type FinishFacts = z.infer<typeof finishFactsSchema>;
export type ManifestFacts = NonNullable<FinishFacts['manifest']>;

export type FinishCheckResult =
  | {
      status: 'passed';
      defects: [];
      facts: FinishFacts;
    }
  | {
      status: 'failed';
      defects: [FinishDefect, ...FinishDefect[]];
      /** Partial positive facts are retained so diagnostics remain auditable. */
      facts: FinishFacts;
    };
