import { MANIFEST_FILENAME } from '../../run/artifacts.js';
import { TRANSCRIPT_FILENAME } from '../../run/transcript.js';
import {
  outputContractSchema,
  type OutputColumn,
  type OutputContract,
  type OutputSpec,
  type TableRule,
} from './outputContract.schema.js';

// Imperative validation over the output contract (see outputContract.schema.js
// for the contract's shape and the reasoning behind it). Cross-field checks
// live here, as plain code, rather than as Zod refinements: refinements are
// dropped by `z.toJSONSchema()` (so the model would never see them anyway),
// and hand-written messages name the offending id, column, or filename —
// which is what makes one rejected call enough for the model to correct
// course.

/**
 * Run-dir filenames a contract may never claim: the run's own records. A
 * contract output that collided with one of these would make the agent
 * overwrite the provenance used to grade it. Compared case-insensitively because run directories live on
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
