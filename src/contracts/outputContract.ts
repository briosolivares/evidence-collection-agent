import { z } from 'zod';

import { MANIFEST_FILENAME } from '../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../run/transcript.js';

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
// Cross-field checks live in `validateOutputContract()` rather than in the
// Zod schema on purpose: Zod refinements are dropped by `z.toJSONSchema()`
// (so the model would never see them anyway), and hand-written messages name
// the offending id, column, or filename — which is what makes one rejected
// call enough for the model to correct course.

/** A document's evidence requirement when the task does not explicitly state
 * one. The initializer may preserve requirements, but must not create them. */
export const DEFAULT_EVIDENCE_REQUIREMENT = 'none';

/** A document's evidence presentation when the contract omits it. Citations
 * are structural metadata by default; visible footnotes are opt-in, because
 * an unrequested footnote apparatus changes the deliverable's shape. */
export const DEFAULT_EVIDENCE_PRESENTATION = 'hidden';

/**
 * Run-dir filenames a contract may never claim: the run's own records. A
 * contract output that collided with one of these would make the agent
 * overwrite the provenance used to grade it. Mirrors the reserved set
 * enforced for tool-supplied paths in `src/tools/shared/evidence.ts`;
 * compared case-insensitively because run directories live on
 * case-insensitive filesystems (macOS, Windows).
 */
export const RESERVED_OUTPUT_FILENAMES: readonly string[] = [
  MANIFEST_FILENAME,
  TRANSCRIPT_FILENAME,
  'metrics.json',
];

/**
 * Whether a bare filename satisfies a `filenamePattern` from a `screenshots`
 * or `download` output spec. `*` matches any run of characters; everything
 * else is literal.
 *
 * Lives here, beside the field it interprets, because TWO places must agree on
 * it: the capture tools check a filename before writing it, and the submission
 * checks count the captures that matched. Two implementations would let a tool
 * accept a name the submission check then rejects.
 */
export function matchesFilenamePattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

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

/** A checkable, table-wide rule. Row counts, uniqueness, and known expected
 * values are exactly the properties code can settle without a model, which is
 * why they live in the contract instead of in prose. */
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
  z.strictObject({
    type: z.literal('matches_expected_values'),
    column: nonBlankString.describe('Declared column the expected values apply to'),
    expected: z.array(nonBlankString).min(1).describe('Values that must appear in that column'),
    exhaustive: z
      .boolean()
      .optional()
      .describe(
        'True when the expected values are the COMPLETE set of row keys: the column must ' +
          'contain every one of them and nothing else. Set this whenever the population is ' +
          'known up front, so code catches an invented or duplicated row instead of leaving ' +
          'it to the verifier',
      ),
    source: z
      .discriminatedUnion('kind', [
        // Where the expectation came from. The verifier needs this to tell an
        // explicit user requirement from something the run learned by
        // browsing — only the first is authoritative on its own.
        z.strictObject({ kind: z.literal('original_task') }),
        z.strictObject({
          kind: z.literal('evidence'),
          evidenceIds: z.array(nonBlankString).min(1),
        }),
      ])
      .describe('Whether the expectation comes from the original task or from collected evidence'),
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
    requiredSections: z
      .array(nonBlankString)
      .min(1)
      .optional()
      .describe('Section headings the document must contain, in no particular order'),
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
    mustShow: z
      .array(nonBlankString)
      .min(1)
      .optional()
      .describe(
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
        mustShow: z
          .array(nonBlankString)
          .min(1)
          .optional()
          .describe(
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
    allowedMediaTypes: z
      .array(nonBlankString)
      .min(1)
      .optional()
      .describe('Accepted media types, e.g. ["application/pdf"]'),
    sourceUrlPattern: nonBlankString
      .optional()
      .describe('Pattern the download source URL must match'),
  }),
]);

/** The contract itself: required outputs, plus the judgment-shaped
 * expectations and material assumptions that surround them. */
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
  assumptions: z
    .array(nonBlankString)
    .optional()
    .describe(
      'Deprecated compatibility field. Initializers must not add availability ' +
        'assumptions or requirements the user did not state',
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

/** The outcome of validating the run's one immutable output contract. Errors
 * are plural so one rejected initializer call can fix every problem. */
export type OutputContractValidation =
  | { ok: true; contract: OutputContract }
  | { ok: false; errors: [string, ...string[]] };

/**
 * Validate the run's immutable initial contract: shape, then every cross-field
 * rule.
 *
 * @param input - raw contract value; never trusted
 * @returns `ok: true` with the contract — Zod defaults applied
 *   (a document's evidence requirement and presentation are always explicit
 *   in the stored form) — or `ok: false` with one message per problem found.
 *   Every message names the offending output id, column, filename, or rule
 *   so the model can correct the whole contract in one follow-up call
 *
 * Rejects, beyond the schema: duplicate output ids; two outputs claiming the
 * same file; unsafe filenames and filename patterns (path separators,
 * absolute paths, `.`/`..`, control characters, the run's own reserved
 * names); duplicate table columns; enum columns with repeated values;
 * invalid IANA timezones or BCP 47 locales; conflicting table rules
 * (repeated count rules, a minimum above an exact count, uniqueness or
 * expected values naming an undeclared column, more expected values than
 * rows); a download constrained by nothing; a document requiring
 * per-section evidence with no sections, or visible footnotes with no
 * evidence at all; an external action demanding visible proof content
 * while requiring no proof screenshots.
 */
export function validateOutputContract(input: unknown): OutputContractValidation {
  const parsed = outputContractSchema.safeParse(input);
  if (!parsed.success) {
    // Shape errors short-circuit: cross-field checks assume a well-formed
    // contract, and a model reading both lists at once cannot tell which
    // complaint to fix first.
    return failure(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(input)';
        return `at ${path}: ${issue.message}`;
      }),
    );
  }

  const errors = checkOutputs(parsed.data.outputs);
  if (errors.length > 0) return failure(errors);

  return { ok: true, contract: parsed.data };
}

/** Every cross-field check over the contract's outputs. */
function checkOutputs(outputs: readonly OutputSpec[]): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const claimedFiles = new Map<string, string>();

  for (const output of outputs) {
    if (seenIds.has(output.id)) {
      errors.push(
        `duplicate output id ${JSON.stringify(output.id)}: every output needs its own id`,
      );
    }
    seenIds.add(output.id);

    switch (output.kind) {
      case 'table': {
        errors.push(...checkFilename(output, output.filename, claimedFiles));
        errors.push(...checkColumns(output.id, output.columns));
        errors.push(...checkRules(output.id, output.columns, output.rules));
        break;
      }
      case 'document': {
        errors.push(...checkFilename(output, output.filename, claimedFiles));
        errors.push(...checkDocument(output));
        break;
      }
      case 'screenshots': {
        if (output.filenamePattern !== undefined) {
          errors.push(...checkFilenamePattern(output.id, output.filenamePattern));
        }
        break;
      }
      case 'download': {
        if (output.filenamePattern !== undefined) {
          errors.push(...checkFilenamePattern(output.id, output.filenamePattern));
        }
        errors.push(...checkDownload(output));
        break;
      }
      case 'external_action': {
        errors.push(...checkExternalAction(output));
        break;
      }
    }
  }
  return errors;
}

/** Confine a contract filename to one safe name inside the published
 * artifacts area, and reject two outputs claiming the same file. The
 * contract names files the runtime later resolves through `resolveRunPath`;
 * catching the unsafe name here means the failure arrives while the model
 * can still fix it cheaply, not at publish time. */
function checkFilename(
  output: OutputSpec,
  filename: string,
  claimedFiles: Map<string, string>,
): string[] {
  const errors: string[] = [];
  const problem = unsafeFilenameReason(filename);
  if (problem !== undefined) {
    errors.push(`output ${JSON.stringify(output.id)} filename ${JSON.stringify(filename)}: ${problem}`);
    // A rejected name is not recorded as claimed: reporting it a second time
    // as a duplicate would obscure the real problem.
    return errors;
  }
  const key = filename.toLowerCase();
  const owner = claimedFiles.get(key);
  if (owner !== undefined) {
    errors.push(
      `outputs ${JSON.stringify(owner)} and ${JSON.stringify(output.id)} both write ` +
        `${JSON.stringify(filename)}: each output needs its own file`,
    );
  } else {
    claimedFiles.set(key, output.id);
  }
  return errors;
}

/** Why a filename cannot be used, or undefined when it is safe. */
function unsafeFilenameReason(filename: string): string | undefined {
  if (filename.trim() !== filename) {
    return 'must not begin or end with whitespace';
  }
  if (/[/\\]/.test(filename)) {
    return 'must be a bare filename with no directory separators (the runtime publishes it under artifacts/)';
  }
  if (/^[A-Za-z]:/.test(filename)) {
    return 'must be a relative bare filename, not an absolute path';
  }
  if (filename === '.' || filename === '..') {
    return 'is a directory reference, not a filename';
  }
  // eslint-disable-next-line no-control-regex -- control characters in a
  // filename are a smuggling attempt or a copy/paste accident, never intent.
  if (/[\u0000-\u001f\u007f]/.test(filename)) {
    return 'must not contain control characters';
  }
  if (RESERVED_OUTPUT_FILENAMES.some((reserved) => reserved.toLowerCase() === filename.toLowerCase())) {
    return `is reserved for the run's own records (${RESERVED_OUTPUT_FILENAMES.join(', ')})`;
  }
  return undefined;
}

/** A filename pattern constrains names the same way a filename does, so it
 * inherits the same safety rules (wildcards excepted). */
function checkFilenamePattern(outputId: string, pattern: string): string[] {
  const problem = unsafeFilenameReason(pattern);
  return problem === undefined
    ? []
    : [
        `output ${JSON.stringify(outputId)} filenamePattern ${JSON.stringify(pattern)}: ${problem}`,
      ];
}

/** Column-level checks: distinct headers, well-formed enum value sets, and
 * real timezones/locales for date rendering. */
function checkColumns(outputId: string, columns: readonly OutputColumn[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    if (column.name.trim() !== column.name) {
      errors.push(
        `output ${JSON.stringify(outputId)} column ${JSON.stringify(column.name)}: ` +
          `column names must not begin or end with whitespace`,
      );
    }
    if (seen.has(column.name)) {
      errors.push(
        `output ${JSON.stringify(outputId)} declares column ${JSON.stringify(column.name)} twice`,
      );
    }
    seen.add(column.name);

    if (column.type === 'enum') {
      const duplicates = duplicatesOf(column.values);
      if (duplicates.length > 0) {
        errors.push(
          `output ${JSON.stringify(outputId)} column ${JSON.stringify(column.name)} repeats ` +
            `enum value(s) ${duplicates.map((value) => JSON.stringify(value)).join(', ')}`,
        );
      }
    }

    if (column.type === 'date' || column.type === 'datetime') {
      if (column.timezone !== undefined && !isValidTimezone(column.timezone)) {
        errors.push(
          `output ${JSON.stringify(outputId)} column ${JSON.stringify(column.name)}: ` +
            `${JSON.stringify(column.timezone)} is not a valid IANA timezone name`,
        );
      }
      if (column.format.kind === 'unicode_pattern' && !isValidLocale(column.format.locale)) {
        errors.push(
          `output ${JSON.stringify(outputId)} column ${JSON.stringify(column.name)}: ` +
            `${JSON.stringify(column.format.locale)} is not a valid BCP 47 locale tag`,
        );
      }
    }
  }
  return errors;
}

/** Rule-level checks: rules must be mutually satisfiable and may only name
 * declared columns. A contract that no table can satisfy would otherwise
 * burn the whole run before failing. */
function checkRules(
  outputId: string,
  columns: readonly OutputColumn[],
  rules: readonly TableRule[],
): string[] {
  const errors: string[] = [];
  const declared = new Set(columns.map((column) => column.name));
  const label = `output ${JSON.stringify(outputId)}`;

  const exactRules = rules.filter((rule) => rule.type === 'exact_row_count');
  const minimumRules = rules.filter((rule) => rule.type === 'minimum_row_count');
  if (exactRules.length > 1) {
    errors.push(`${label} declares ${exactRules.length} exact_row_count rules; at most one is allowed`);
  }
  if (minimumRules.length > 1) {
    errors.push(
      `${label} declares ${minimumRules.length} minimum_row_count rules; at most one is allowed`,
    );
  }
  const exact = exactRules[0];
  const minimum = minimumRules[0];
  if (exact !== undefined && minimum !== undefined && minimum.value > exact.value) {
    errors.push(
      `${label} requires at least ${minimum.value} rows but exactly ${exact.value}: ` +
        `no table can satisfy both`,
    );
  }

  const seenUniqueSets = new Set<string>();
  const seenExpectedColumns = new Set<string>();
  for (const rule of rules) {
    if (rule.type === 'unique') {
      const duplicates = duplicatesOf(rule.columns);
      if (duplicates.length > 0) {
        errors.push(
          `${label} unique rule repeats column(s) ` +
            `${duplicates.map((value) => JSON.stringify(value)).join(', ')}`,
        );
      }
      for (const column of rule.columns) {
        if (!declared.has(column)) {
          errors.push(
            `${label} unique rule names undeclared column ${JSON.stringify(column)}`,
          );
        }
      }
      // Order-insensitive: unique over [a, b] and [b, a] are one rule.
      const key = [...rule.columns].sort().join('\u0000');
      if (seenUniqueSets.has(key)) {
        errors.push(
          `${label} declares the same unique rule twice over ` +
            `${rule.columns.map((column) => JSON.stringify(column)).join(', ')}`,
        );
      }
      seenUniqueSets.add(key);
    }

    if (rule.type === 'matches_expected_values') {
      if (!declared.has(rule.column)) {
        errors.push(
          `${label} matches_expected_values rule names undeclared column ` +
            `${JSON.stringify(rule.column)}`,
        );
      }
      if (seenExpectedColumns.has(rule.column)) {
        errors.push(
          `${label} declares two matches_expected_values rules for column ` +
            `${JSON.stringify(rule.column)}`,
        );
      }
      seenExpectedColumns.add(rule.column);

      const duplicates = duplicatesOf(rule.expected);
      if (duplicates.length > 0) {
        errors.push(
          `${label} matches_expected_values rule for column ${JSON.stringify(rule.column)} ` +
            `repeats value(s) ${duplicates.map((value) => JSON.stringify(value)).join(', ')}`,
        );
      }
      if (exact !== undefined && rule.expected.length > exact.value) {
        errors.push(
          `${label} expects ${rule.expected.length} values in column ` +
            `${JSON.stringify(rule.column)} but allows only ${exact.value} rows`,
        );
      }
    }
  }
  return errors;
}

/** Document-level checks: the evidence policy must be satisfiable and
 * self-consistent. */
function checkDocument(output: Extract<OutputSpec, { kind: 'document' }>): string[] {
  const errors: string[] = [];
  const label = `output ${JSON.stringify(output.id)}`;

  if (output.requiredSections !== undefined) {
    const duplicates = duplicatesOf(output.requiredSections);
    if (duplicates.length > 0) {
      errors.push(
        `${label} repeats required section(s) ` +
          `${duplicates.map((value) => JSON.stringify(value)).join(', ')}`,
      );
    }
  }
  if (
    output.evidenceRequirement === 'per_required_section' &&
    (output.requiredSections === undefined || output.requiredSections.length === 0)
  ) {
    errors.push(
      `${label} requires evidence per required section but declares no requiredSections`,
    );
  }
  if (output.evidenceRequirement === 'none' && output.evidencePresentation === 'footnotes') {
    errors.push(
      `${label} asks for footnoted citations but requires no evidence: ` +
        `raise evidenceRequirement or drop the footnotes`,
    );
  }
  return errors;
}

/** External-action checks: the mustShow expectation binds to proof captures,
 * so requiring visible content without requiring any capture is a contract
 * no run could satisfy deliberately. */
function checkExternalAction(
  output: Extract<OutputSpec, { kind: 'external_action' }>,
): string[] {
  if (output.proof.mustShow !== undefined && output.proof.screenshots === undefined) {
    return [
      `output ${JSON.stringify(output.id)} lists proof.mustShow but requires no ` +
        `proof.screenshots: require at least one screenshot or drop mustShow`,
    ];
  }
  return [];
}

/** A download must constrain something. "Any file the browser happened to
 * save" is not a requirement, and code could never check it. */
function checkDownload(output: Extract<OutputSpec, { kind: 'download' }>): string[] {
  const errors: string[] = [];
  const label = `output ${JSON.stringify(output.id)}`;

  const constrained =
    output.filenamePattern !== undefined ||
    output.allowedMediaTypes !== undefined ||
    output.sourceUrlPattern !== undefined;
  if (!constrained) {
    errors.push(
      `${label} constrains nothing: a download output needs at least one of ` +
        `filenamePattern, allowedMediaTypes, or sourceUrlPattern, or any saved file would satisfy it`,
    );
  }
  for (const mediaType of output.allowedMediaTypes ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mediaType)) {
      errors.push(
        `${label} media type ${JSON.stringify(mediaType)} is not a type/subtype pair, ` +
          `e.g. "application/pdf"`,
      );
    }
  }
  const duplicates = duplicatesOf(output.allowedMediaTypes ?? []);
  if (duplicates.length > 0) {
    errors.push(
      `${label} repeats media type(s) ${duplicates.map((value) => JSON.stringify(value)).join(', ')}`,
    );
  }
  return errors;
}

/** Values appearing more than once, each reported once, in first-seen
 * order. */
function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/** True iff the runtime's ICU data recognizes the timezone. `Intl` is the
 * same authority the date formatter will use, so accepting anything it
 * rejects would only defer the failure to render time. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** True iff the tag is a structurally valid BCP 47 locale. */
function isValidLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length > 0;
  } catch {
    return false;
  }
}

/** Build the failure branch, preserving the non-empty guarantee in the type
 * without a cast. */
function failure(errors: string[]): { ok: false; errors: [string, ...string[]] } {
  const [first, ...rest] = errors;
  return { ok: false, errors: [first, ...rest] };
}
