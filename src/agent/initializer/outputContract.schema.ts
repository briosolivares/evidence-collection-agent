import { z } from 'zod';

// The output contract: the one typed statement of what a run must produce
// (docs/revised-browser-agent-proposal.md, "Define a small, validated output
// contract"). It replaces the prose INTENT.md/CONTRACT.md pair — nothing here
// is parsed out of model prose, and nothing downstream re-derives
// requirements from headings. The worker, the initializer, the code-based
// completion checks, and the verifier all read the same validated object.
//
// Two boundaries shape this module:
//
//  1. The contract describes only the END STATE — which files or captures
//     must exist and their exact structure. It carries no research plan, no
//     browser steps, no preferred sites, and no per-entity progress. Those
//     belong to the loop, not to the requirements.
//  2. Validation is total and mechanical. Anything a schema plus cross-field
//     code can settle is settled here, before a single browser action runs,
//     so an impossible or self-contradicting contract fails on turn one
//     instead of after minutes of collection. Judgment-shaped requirements go
//     in `contentExpectations`, which code deliberately does not check.
//
// Cross-field checks live in `validateOutputContract()` (./validate.js)
// rather than in the Zod schema on purpose: Zod refinements are dropped by
// `z.toJSONSchema()` (so the model would never see them anyway), and
// hand-written messages name the offending id, column, or filename — which
// is what makes one rejected call enough for the model to correct course.

/** A document's evidence requirement when the task does not explicitly state
 * one. The initializer may preserve requirements, but must not create them. */
export const DEFAULT_EVIDENCE_REQUIREMENT = 'none';

/** A document's evidence presentation when the contract omits it. Citations
 * are structural metadata by default; visible footnotes are opt-in, because
 * an unrequested footnote apparatus changes the deliverable's shape. */
export const DEFAULT_EVIDENCE_PRESENTATION = 'hidden';

/** A string that carries information: present, non-empty, and not just
 * whitespace. `min(1)` alone would accept `"   "`, which reads as a filled-in
 * field while saying nothing. */
const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'must not be blank');

/** A count or limit: a finite positive integer. Rejects `NaN`, `Infinity`,
 * negatives, zero, and fractions — an output required "0 times" or "1.5
 * times" is a contract bug, never a requirement. */
const positiveInt = z.number().int().positive();

/** An optional constraint list where an empty array plainly means "none":
 * models legitimately write `[]` instead of omitting the field, and rejecting
 * that can kill a run's only contract attempt. Normalizing to absent keeps
 * one canonical form, so consumers keep their `!== undefined` semantics and
 * an empty `allowedMediaTypes` can never read as "allow nothing". */
const optionalConstraintList = z
  .array(nonBlankString)
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

/**
 * An output id: a short machine-usable token. Later tools reference outputs
 * by id (row upserts, completeness evidence, verifier findings), so ids must
 * survive being embedded in messages and filenames without quoting.
 */
const outputIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must start with a letter or digit and contain only letters, digits, ".", "_", or "-"',
  );

/** How a date or datetime column is rendered in the finished output. Dates
 * are stored internally in ISO form; a display format is recorded exactly
 * (UTS #35 pattern plus locale) so rendering never depends on an ambient
 * locale. */
export const dateOutputFormatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('iso_date') }),
  z.strictObject({ kind: z.literal('iso_datetime') }),
  z.strictObject({
    kind: z.literal('unicode_pattern'),
    /** Unicode Technical Standard #35 tokens, e.g. "MMM d, yyyy". */
    pattern: nonBlankString.describe(
      'Unicode Technical Standard #35 date pattern, e.g. "MMM d, yyyy"',
    ),
    locale: nonBlankString.describe('BCP 47 locale tag the pattern is rendered in, e.g. "en-US"'),
  }),
]);

/** One column of a table output: its exact header, whether every row must
 * fill it, and the value contract cells are validated against. */
export const outputColumnSchema = z.discriminatedUnion('type', [
  z.strictObject({
    name: nonBlankString.describe('Exact column header, copied verbatim from the request'),
    required: z.boolean().describe('True when every row must carry a value for this column'),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'url']),
  }),
  z.strictObject({
    name: nonBlankString.describe('Exact column header, copied verbatim from the request'),
    required: z.boolean().describe('True when every row must carry a value for this column'),
    type: z.literal('enum'),
    values: z
      .array(nonBlankString)
      .min(1)
      .describe('The complete set of accepted values, copied verbatim from the source'),
  }),
  z.strictObject({
    name: nonBlankString.describe('Exact column header, copied verbatim from the request'),
    required: z.boolean().describe('True when every row must carry a value for this column'),
    type: z.enum(['date', 'datetime']),
    format: dateOutputFormatSchema,
    timezone: nonBlankString
      .optional()
      .describe('IANA timezone name the values are interpreted in, e.g. "America/New_York"'),
  }),
]);

/** A checkable, table-wide rule. Row counts and uniqueness are exactly the
 * properties code can settle without a model, which is why they live in the
 * contract instead of in prose. */
export const tableRuleSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('exact_row_count'),
    value: positiveInt.describe('The table must contain exactly this many rows'),
  }),
  z.strictObject({
    type: z.literal('minimum_row_count'),
    value: positiveInt.describe('The table must contain at least this many rows'),
  }),
  z.strictObject({
    type: z.literal('unique'),
    columns: z
      .array(nonBlankString)
      .min(1)
      .describe('Declared column names whose combined values must be distinct across rows'),
  }),
]);

/** How many captures or files an output requires. Exactly-N and at-least-N
 * are different promises, so they are different shapes rather than one
 * nullable pair. */
export const outputCountSchema = z.union([
  z.strictObject({ exact: positiveInt }),
  z.strictObject({ minimum: positiveInt }),
]);

/** One required deliverable. `table` and `document` name a file; `screenshots`
 * and `download` describe a set of captures constrained by count, filename
 * pattern, media type, or source URL; `external_action` is a requested action
 * on an external service, proven by captures taken at its destination. */
export const outputSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: outputIdSchema.describe('Stable id later tool calls reference this output by'),
    kind: z.literal('table'),
    filename: nonBlankString.describe(
      'Bare filename (no directories) the runtime publishes under artifacts/',
    ),
    format: z.enum(['csv', 'json', 'markdown']),
    columns: z
      .array(outputColumnSchema)
      .min(1)
      .describe('Columns in their exact required output order'),
    rules: z.array(tableRuleSchema).describe('Table-wide rules code checks before verification'),
  }),
  z.strictObject({
    id: outputIdSchema.describe('Stable id later tool calls reference this output by'),
    kind: z.literal('document'),
    filename: nonBlankString.describe(
      'Bare filename (no directories) the runtime publishes under artifacts/',
    ),
    format: z.enum(['markdown', 'text', 'pdf']),
    requiredSections: optionalConstraintList.describe(
      'Section headings the document must contain, in no particular order',
    ),
    evidenceRequirement: z
      .enum(['none', 'at_least_one', 'per_required_section'])
      .default(DEFAULT_EVIDENCE_REQUIREMENT)
      .describe(
        'Evidence explicitly required by the task. Defaults to none when the task ' +
          'does not state an evidence requirement',
      ),
    evidencePresentation: z
      .enum(['hidden', 'footnotes'])
      .default(DEFAULT_EVIDENCE_PRESENTATION)
      .describe(
        'Whether citations are visible in the document. Defaults to hidden; use ' +
          'footnotes when the request asks for visible citations',
      ),
  }),
  z.strictObject({
    id: outputIdSchema.describe('Stable id later tool calls reference this output by'),
    kind: z.literal('screenshots'),
    count: outputCountSchema.describe('How many screenshots the run must publish'),
    filenamePattern: nonBlankString
      .optional()
      .describe('Bare filename pattern the captures must match, e.g. "profile-*.png"'),
    mustShow: optionalConstraintList.describe(
      'What must be visible in the images. Deliberately semantic: checked by an ' +
        'image-capable verifier, never by code',
    ),
  }),
  z.strictObject({
    id: outputIdSchema.describe('Stable id later tool calls reference this output by'),
    kind: z.literal('external_action'),
    description: nonBlankString.describe(
      'The requested action on an external service, copied verbatim from the request, ' +
        'e.g. "add each member to a Google Sheets spreadsheet"',
    ),
    proof: z
      .strictObject({
        sourceUrlPattern: nonBlankString.describe(
          'Pattern the destination URL of published proof captures must match, ' +
            'e.g. "https://docs.google.com/spreadsheets/d/*"',
        ),
        screenshots: outputCountSchema
          .optional()
          .describe(
            'How many PNG proof screenshots captured at the destination the run must publish',
          ),
        mustShow: optionalConstraintList.describe(
          'What must be visible in the proof captures. Deliberately semantic: checked ' +
            'by the verifier, never by code',
        ),
      })
      .describe(
        'Auditable proof the action happened at its real destination. Source URLs of ' +
          'browser captures are runtime-derived provenance, never worker claims',
      ),
  }),
  z.strictObject({
    id: outputIdSchema.describe('Stable id later tool calls reference this output by'),
    kind: z.literal('download'),
    count: outputCountSchema.describe('How many downloaded files the run must publish'),
    filenamePattern: nonBlankString
      .optional()
      .describe('Bare filename pattern the downloads must match, e.g. "*.pdf"'),
    allowedMediaTypes: optionalConstraintList.describe(
      'Accepted media types, e.g. ["application/pdf"]',
    ),
    sourceUrlPattern: nonBlankString
      .optional()
      .describe('Pattern the download source URL must match'),
  }),
]);

/** The contract itself: required outputs, plus the judgment-shaped
 * expectations that surround them. */
export const outputContractSchema = z.strictObject({
  outputs: z
    .array(outputSpecSchema)
    .min(1)
    .describe('Every file or capture the finished run must contain'),
  contentExpectations: z
    .array(nonBlankString)
    .optional()
    .describe(
      'Requirements that need judgment rather than code, e.g. "explain the most ' +
        'material control gaps and support them with evidence"',
    ),
});

/** One column of a table output. */
export type OutputColumn = z.infer<typeof outputColumnSchema>;
/** One table-wide checkable rule. */
export type TableRule = z.infer<typeof tableRuleSchema>;
/** One required deliverable. */
export type OutputSpec = z.infer<typeof outputSpecSchema>;
/** The validated contract. Note that `outputs` and table `columns` are plain
 * arrays in the type but carry a runtime minimum of one element. */
export type OutputContract = z.infer<typeof outputContractSchema>;
