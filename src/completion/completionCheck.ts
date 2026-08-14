import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { OutputContract, OutputSpec } from '../contracts/outputContract.js';
import {
  ARTIFACTS_DIR,
  MANIFEST_FILENAME,
  SCRATCH_DIR,
  writeArtifact,
  type Manifest,
  type ManifestEntry,
} from '../run/artifacts.js';
import { renderOutputTable } from '../outputs/renderTable.js';
import type { OutputTableStore } from '../outputs/outputTable.js';
import { resolveRunPath } from '../run/runDir.js';

// The code-based completion check: everything about a proposed completion
// that can be settled mechanically, settled BEFORE a verifier call is spent.
//
// The division of labour matters. A missing file, an unparseable CSV, a
// wrong column order, a row count that contradicts a declared rule, a
// leftover TODO — none of these need a model's judgment, and letting a
// verifier attempt die on one wastes a correction round the run may need
// for something that genuinely requires reading. So code checks run first
// and their failures come back as the submission's own tool result; only a
// submission that survives them reaches the verifier, which then spends its
// attention on the questions only judgment can answer.
//
// Every failure names the output it belongs to and what to do about it: the
// worker should be able to fix everything from one submission result.

/** One objective, mechanically-detected defect. */
export interface CompletionFailure {
  /** Which output the defect belongs to; absent for run-wide problems. */
  outputId?: string;
  /** Short machine-stable code, e.g. "missing_file", "column_mismatch". */
  code: string;
  /** What is wrong and what would fix it. */
  message: string;
}

/**
 * One thing code POSITIVELY established about a published deliverable.
 *
 * The mirror image of a `CompletionFailure`, and it exists because the
 * verifier needs it. Measured live on 2026-08-13: the code checks parsed a
 * CSV, counted exactly 5 data rows, and passed the contract's
 * `exact_row_count: 5`; the verifier then read the same 6-line file, called
 * it "6 data rows plus header" (contradicting itself in the same sentence by
 * citing "lines 2-6"), and returned needs_correction — twice. Two cycles and
 * ~26s spent overturning a count code had already settled, on a file that
 * was correct.
 *
 * Counting is not a judgment call, so handing the verifier the count removes
 * the temptation to re-derive it. What the verifier is uniquely for —
 * task↔contract, completeness of a claimed population, facts↔evidence — is
 * untouched by this.
 */
export interface SettledFact {
  /** Which output the fact is about; absent for run-wide facts. */
  outputId?: string;
  /** Machine-stable code of the check that passed, e.g. "exact_row_count". */
  code: string;
  /** The fact, stated concretely enough that a contradiction is obvious. */
  statement: string;
}

/** The result of one code-check pass. */
export interface CompletionCheckResult {
  /** True iff nothing objective is wrong — the verifier may run. */
  ok: boolean;
  /** Every defect found, in contract order. */
  failures: CompletionFailure[];
  /** What code established about the outputs it could read, in contract
   * order. Populated whether or not the pass succeeded; only the facts of
   * checks that actually passed appear. */
  settled: SettledFact[];
}

/** Placeholder text a finished deliverable must not contain. Deliberately
 * narrow: these are unambiguous "not done yet" markers, not a prose-quality
 * filter (that judgment is the verifier's). */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bTBD\b/,
  /\bXXX\b/,
  /\bLorem ipsum\b/i,
  /\bplaceholder\b/i,
  /\bN\/A pending\b/i,
];

/**
 * Run every objective check for a proposed completion.
 *
 * Rendering happens FIRST, before any check reads the directory: a table
 * output does not exist as a file until the renderer writes it, so checking
 * for its presence beforehand reports `missing_file` for a table that is
 * complete and correct. That is not hypothetical — before the store was
 * passed in, a live run built five valid typed rows, was told its CSV did not
 * exist, and hand-wrote the file with `write_file` to get past the check.
 * Which is precisely the model-authored deliverable typed rows exist to
 * replace.
 *
 * @param runDir - the run directory
 * @param contract - the run's current contract; every requirement checked
 *   here comes from it, so a run with no contract has nothing objective to
 *   check and passes trivially
 * @param tables - the run's table store. Omitted only by callers that have no
 *   typed rows to render (and by tests that pre-write their fixtures); when
 *   absent, a declared table output is checked as a plain file
 * @param evidenceExists - looks up whether an evidence id still resolves.
 *   Omitted only by callers with no evidence store; when absent, dangling
 *   evidence references are not checked (there is nothing to check them
 *   against)
 * @returns ok with no failures, or every defect found, plus the facts code
 *   settled along the way. Never throws for a defect — an unreadable or
 *   absent file IS a finding, not an exception
 */
export function runCompletionCheck(
  runDir: string,
  contract: OutputContract,
  tables?: OutputTableStore,
  evidenceExists?: (evidenceId: string) => boolean,
): CompletionCheckResult {
  const failures: CompletionFailure[] = [
    // A table that cannot be rendered is reported as its own failure rather
    // than surfacing later as a confusing missing_file.
    ...(tables === undefined
      ? []
      : renderTableOutputs(runDir, onlyTablesWithRows(contract, tables), tables)),
    ...validateManifestIntegrity(runDir),
    // A count-ruled table's own row count can never prove a claim about the
    // whole population — see validateTableCompleteness's own docstring. This
    // must run whether or not there is an evidence store to check references
    // against, so it is gated on `tables` alone.
    ...(tables === undefined ? [] : validateTableCompleteness(contract, tables)),
    // A row's citation can stop resolving after it was upserted, which
    // neither rendering nor the manifest check above catches — see
    // validateEvidenceReferences's own docstring.
    ...(tables === undefined || evidenceExists === undefined
      ? []
      : validateEvidenceReferences(contract, tables, evidenceExists)),
  ];
  // Failures and settled facts come from the SAME parse of the same bytes, so
  // the two can never disagree about the file they describe.
  const outputs = expectedOutputsOutcome(runDir, contract);
  failures.push(...outputs.failures, ...validateDocumentOutputs(runDir, contract));
  return { ok: failures.length === 0, failures, settled: outputs.settled };
}

/**
 * The contract narrowed to table outputs that actually have typed rows.
 *
 * Rendering at the submission boundary must not clobber a deliverable the run
 * obtained some other way — a CSV downloaded straight from the site, say —
 * with a header-only file built from an empty store. A table with no rows has
 * nothing to publish, so the directory is left as it is and the presence and
 * rule checks report the truth about it.
 *
 * A direct `renderTableOutputs` call still renders empties (that is its own
 * tested contract); this is the boundary's policy, not the renderer's.
 */
function onlyTablesWithRows(
  contract: OutputContract,
  tables: OutputTableStore,
): OutputContract {
  // tables() lists only tables that were touched, so this never CREATES an
  // empty table as a side effect of asking whether one exists.
  const withRows = new Set(
    tables
      .tables()
      .filter((table) => table.rows.length > 0)
      .map((table) => table.outputId),
  );
  return {
    ...contract,
    outputs: contract.outputs.filter(
      (output) => output.kind !== 'table' || withRows.has(output.id),
    ),
  };
}

/**
 * Check that the manifest describes the run directory truthfully: every
 * recorded artifact still exists, and its bytes still hash to what was
 * recorded.
 *
 * A drifted hash means a file changed after it was captured — the provenance
 * the manifest exists to provide is broken, and a grader reading it would be
 * misled about what was actually collected.
 */
export function validateManifestIntegrity(runDir: string): CompletionFailure[] {
  const manifestPath = join(runDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return [
      { code: 'missing_manifest', message: `${MANIFEST_FILENAME} is missing from the run.` },
    ];
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    return [
      {
        code: 'unparseable_manifest',
        message: `${MANIFEST_FILENAME} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }

  const failures: CompletionFailure[] = [];
  for (const entry of manifest.artifacts ?? []) {
    let absPath: string;
    try {
      absPath = resolveRunPath(runDir, entry.filename);
    } catch {
      failures.push({
        code: 'manifest_path_escape',
        message: `Manifest entry ${entry.filename} does not resolve inside the run directory.`,
      });
      continue;
    }
    if (!existsSync(absPath)) {
      failures.push({
        code: 'missing_recorded_file',
        message: `${entry.filename} is recorded in the manifest but no longer exists.`,
      });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(absPath)).digest('hex');
    if (actual !== entry.sha256) {
      failures.push({
        code: 'hash_mismatch',
        message:
          `${entry.filename} changed after it was recorded (manifest hash ${entry.sha256.slice(0, 12)}…, ` +
          `actual ${actual.slice(0, 12)}…). Re-publish it so its provenance is accurate.`,
      });
    }
  }
  return failures;
}

/**
 * Check every output the contract requires: that it exists, is non-empty,
 * parses in its declared format, carries exactly the declared columns in
 * order, satisfies its declared row-count/uniqueness/expected-value rules,
 * contains its required sections, and holds no leftover placeholders.
 * Screenshot and download outputs are checked by count and filename
 * pattern against the manifest's published entries.
 */
export function validateExpectedOutputs(
  runDir: string,
  contract: OutputContract,
): CompletionFailure[] {
  return expectedOutputsOutcome(runDir, contract).failures;
}

/**
 * The same pass, keeping the settled facts the failure-only view discards.
 * One parse feeds both halves — see {@link SettledFact} for why the verifier
 * is given the positive half at all.
 */
function expectedOutputsOutcome(
  runDir: string,
  contract: OutputContract,
): { failures: CompletionFailure[]; settled: SettledFact[] } {
  const failures: CompletionFailure[] = [];
  const settled: SettledFact[] = [];
  const published = publishedEntries(runDir);

  for (const output of contract.outputs) {
    switch (output.kind) {
      case 'table': {
        const outcome = checkTableOutput(runDir, output);
        failures.push(...outcome.failures);
        settled.push(...outcome.settled);
        break;
      }
      case 'document':
        failures.push(...checkDocumentOutput(runDir, output));
        break;
      case 'screenshots':
      case 'download':
        failures.push(...checkCaptureOutput(output, published));
        break;
    }
  }
  return { failures, settled };
}

/** The manifest's published (artifacts/) entries, or [] when unreadable —
 * an unreadable manifest is already reported by validateManifestIntegrity. */
function publishedEntries(runDir: string): ManifestEntry[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'),
    ) as Manifest;
    return (manifest.artifacts ?? []).filter((entry) => entry.roles !== undefined);
  } catch {
    return [];
  }
}

/** Read a required output file, or report why it cannot be read. */
function readOutput(
  runDir: string,
  outputId: string,
  filename: string,
): { text: string } | { failure: CompletionFailure } {
  const relPath = `${ARTIFACTS_DIR}/${filename}`;
  let absPath: string;
  try {
    absPath = resolveRunPath(runDir, relPath);
  } catch {
    return {
      failure: {
        outputId,
        code: 'unsafe_output_path',
        message: `${relPath} does not resolve inside the run directory.`,
      },
    };
  }
  if (!existsSync(absPath)) {
    return {
      failure: {
        outputId,
        code: 'missing_file',
        message: `Required output ${relPath} does not exist.`,
      },
    };
  }
  if (statSync(absPath).size === 0) {
    return {
      failure: {
        outputId,
        code: 'empty_file',
        message: `Required output ${relPath} exists but is empty.`,
      },
    };
  }
  return { text: readFileSync(absPath, 'utf8') };
}

function checkTableOutput(
  runDir: string,
  output: Extract<OutputSpec, { kind: 'table' }>,
): { failures: CompletionFailure[]; settled: SettledFact[] } {
  const read = readOutput(runDir, output.id, output.filename);
  if ('failure' in read) return { failures: [read.failure], settled: [] };

  const failures: CompletionFailure[] = [];
  const expectedColumns = output.columns.map((column) => column.name);
  let rows: Array<Record<string, string>> = [];

  if (output.format === 'csv') {
    const parsed = parseCsv(read.text);
    if (parsed === undefined) {
      return {
        failures: [
          {
            outputId: output.id,
            code: 'unparseable_csv',
            message: `${output.filename} could not be parsed as CSV.`,
          },
        ],
        settled: [],
      };
    }
    if (
      parsed.header.length !== expectedColumns.length ||
      parsed.header.some((name, index) => name !== expectedColumns[index])
    ) {
      failures.push({
        outputId: output.id,
        code: 'column_mismatch',
        message:
          `${output.filename} header is [${parsed.header.join(', ')}] but the contract ` +
          `requires exactly [${expectedColumns.join(', ')}] in that order.`,
      });
    }
    rows = parsed.rows;
  } else if (output.format === 'json') {
    let value: unknown;
    try {
      value = JSON.parse(read.text);
    } catch (error) {
      return {
        failures: [
          {
            outputId: output.id,
            code: 'unparseable_json',
            message: `${output.filename} is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        settled: [],
      };
    }
    if (!Array.isArray(value)) {
      return {
        failures: [
          {
            outputId: output.id,
            code: 'json_not_array',
            message: `${output.filename} must be a JSON array of row objects.`,
          },
        ],
        settled: [],
      };
    }
    rows = value.map((row) => normalizeJsonRow(row));
    for (const [index, row] of rows.entries()) {
      const keys = Object.keys(row);
      if (
        keys.length !== expectedColumns.length ||
        keys.some((name, position) => name !== expectedColumns[position])
      ) {
        failures.push({
          outputId: output.id,
          code: 'column_mismatch',
          message:
            `${output.filename} row ${index + 1} has keys [${keys.join(', ')}] but the ` +
            `contract requires exactly [${expectedColumns.join(', ')}] in that order.`,
        });
        break;
      }
    }
  } else {
    // Markdown: a pipe table whose header row must match the contract.
    const header = parseMarkdownHeader(read.text);
    if (header === undefined) {
      return {
        failures: [
          {
            outputId: output.id,
            code: 'missing_markdown_table',
            message: `${output.filename} contains no Markdown table header row.`,
          },
        ],
        settled: [],
      };
    }
    if (
      header.length !== expectedColumns.length ||
      header.some((name, index) => name !== expectedColumns[index])
    ) {
      failures.push({
        outputId: output.id,
        code: 'column_mismatch',
        message:
          `${output.filename} header is [${header.join(', ')}] but the contract requires ` +
          `exactly [${expectedColumns.join(', ')}] in that order.`,
      });
    }
  }

  failures.push(...checkRequiredValues(output, rows));
  const ruleFailures = validateTableRules(output, rows);
  failures.push(...ruleFailures);
  failures.push(...checkPlaceholders(output.id, output.filename, read.text));
  return { failures, settled: tableSettledFacts(output, rows, ruleFailures, failures) };
}

/**
 * What code established about a table it managed to parse: the row count, and
 * every declared rule that came out satisfied.
 *
 * Only facts from checks that PASSED are reported — a rule that failed is
 * already a failure, and repeating it as a "fact" would be incoherent. The
 * row count is withheld when the columns did not match, because a header
 * mismatch means the parse may have carved rows differently than intended.
 */
function tableSettledFacts(
  output: Extract<OutputSpec, { kind: 'table' }>,
  rows: readonly Record<string, string>[],
  ruleFailures: readonly CompletionFailure[],
  allFailures: readonly CompletionFailure[],
): SettledFact[] {
  if (allFailures.some((failure) => failure.code === 'column_mismatch')) return [];

  const facts: SettledFact[] = [
    {
      outputId: output.id,
      code: 'row_count',
      statement:
        `${ARTIFACTS_DIR}/${output.filename} was parsed as ${output.format} and contains ` +
        `exactly ${rows.length} data row${rows.length === 1 ? '' : 's'} (the header is not ` +
        `a data row). Columns are [${output.columns
          .map((column) => column.name)
          .join(', ')}], matching the contract exactly.`,
    },
  ];
  const failedCodes = new Set(ruleFailures.map((failure) => failure.code));
  for (const rule of output.rules) {
    switch (rule.type) {
      case 'exact_row_count':
        if (!failedCodes.has('row_count_mismatch')) {
          facts.push({
            outputId: output.id,
            code: 'exact_row_count',
            statement: `exact_row_count = ${rule.value} is satisfied: ${rows.length} rows.`,
          });
        }
        break;
      case 'minimum_row_count':
        if (!failedCodes.has('row_count_below_minimum')) {
          facts.push({
            outputId: output.id,
            code: 'minimum_row_count',
            statement: `minimum_row_count = ${rule.value} is satisfied: ${rows.length} rows.`,
          });
        }
        break;
      case 'unique':
        if (!failedCodes.has('duplicate_rows')) {
          facts.push({
            outputId: output.id,
            code: 'unique',
            statement: `[${rule.columns.join(', ')}] is unique across all ${rows.length} rows.`,
          });
        }
        break;
      case 'matches_expected_values':
        if (!failedCodes.has('missing_expected_values')) {
          facts.push({
            outputId: output.id,
            code: 'matches_expected_values',
            statement:
              `column "${rule.column}" contains every one of the ${rule.expected.length} ` +
              `expected value(s) the contract lists.`,
          });
        }
        break;
    }
  }
  return facts;
}

/** Required columns must carry a value in every row. */
function checkRequiredValues(
  output: Extract<OutputSpec, { kind: 'table' }>,
  rows: readonly Record<string, string>[],
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  for (const column of output.columns) {
    if (!column.required) continue;
    const blank = rows.findIndex((row) => (row[column.name] ?? '').trim() === '');
    if (blank >= 0) {
      failures.push({
        outputId: output.id,
        code: 'missing_required_value',
        message:
          `${output.filename} row ${blank + 1} has no value for required column ` +
          `"${column.name}".`,
      });
    }
  }
  return failures;
}

/** Declared row-count, uniqueness, and expected-value rules. */
export function validateTableRules(
  output: Extract<OutputSpec, { kind: 'table' }>,
  rows: readonly Record<string, string>[],
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  for (const rule of output.rules) {
    switch (rule.type) {
      case 'exact_row_count':
        if (rows.length !== rule.value) {
          failures.push({
            outputId: output.id,
            code: 'row_count_mismatch',
            message: `${output.filename} has ${rows.length} rows; the contract requires exactly ${rule.value}.`,
          });
        }
        break;
      case 'minimum_row_count':
        if (rows.length < rule.value) {
          failures.push({
            outputId: output.id,
            code: 'row_count_below_minimum',
            message: `${output.filename} has ${rows.length} rows; the contract requires at least ${rule.value}.`,
          });
        }
        break;
      case 'unique': {
        const seen = new Map<string, number>();
        for (const [index, row] of rows.entries()) {
          const key = rule.columns.map((name) => row[name] ?? '').join('\u0000');
          const first = seen.get(key);
          if (first !== undefined) {
            failures.push({
              outputId: output.id,
              code: 'duplicate_rows',
              message:
                `${output.filename} rows ${first + 1} and ${index + 1} repeat the same ` +
                `[${rule.columns.join(', ')}] values, which the contract requires to be unique.`,
            });
            break;
          }
          seen.set(key, index);
        }
        break;
      }
      case 'matches_expected_values': {
        const present = new Set(rows.map((row) => (row[rule.column] ?? '').trim()));
        const missing = rule.expected.filter((value) => !present.has(value));
        if (missing.length > 0) {
          failures.push({
            outputId: output.id,
            code: 'missing_expected_values',
            message:
              `${output.filename} column "${rule.column}" is missing required value(s): ` +
              `${missing.join(', ')}.`,
          });
        }
        break;
      }
    }
  }
  return failures;
}

function checkDocumentOutput(
  runDir: string,
  output: Extract<OutputSpec, { kind: 'document' }>,
): CompletionFailure[] {
  // A PDF is binary: existence and non-emptiness are all code can settle
  // here, and its rendering is checked where it is produced (T8).
  const read = readOutput(runDir, output.id, output.filename);
  if ('failure' in read) return [read.failure];
  if (output.format === 'pdf') return [];

  const failures: CompletionFailure[] = [];
  for (const section of output.requiredSections ?? []) {
    if (!read.text.includes(section)) {
      failures.push({
        outputId: output.id,
        code: 'missing_section',
        message: `${output.filename} is missing the required section "${section}".`,
      });
    }
  }
  failures.push(...checkPlaceholders(output.id, output.filename, read.text));
  return failures;
}

function checkCaptureOutput(
  output: Extract<OutputSpec, { kind: 'screenshots' | 'download' }>,
  published: readonly ManifestEntry[],
): CompletionFailure[] {
  const pattern = output.filenamePattern;
  const matches = published.filter((entry) => {
    const base = entry.filename.slice(entry.filename.lastIndexOf('/') + 1);
    return pattern === undefined ? true : matchesGlob(base, pattern);
  });

  const label = output.kind === 'screenshots' ? 'screenshot' : 'download';
  const described = pattern === undefined ? '' : ` matching ${pattern}`;
  if ('exact' in output.count) {
    if (matches.length !== output.count.exact) {
      return [
        {
          outputId: output.id,
          code: 'capture_count_mismatch',
          message:
            `The run published ${matches.length} ${label}(s)${described}; the contract ` +
            `requires exactly ${output.count.exact}.`,
        },
      ];
    }
    return [];
  }
  if (matches.length < output.count.minimum) {
    return [
      {
        outputId: output.id,
        code: 'capture_count_below_minimum',
        message:
          `The run published ${matches.length} ${label}(s)${described}; the contract ` +
          `requires at least ${output.count.minimum}.`,
      },
    ];
  }
  return [];
}

function checkPlaceholders(
  outputId: string,
  filename: string,
  text: string,
): CompletionFailure[] {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return [
        {
          outputId,
          code: 'placeholder_text',
          message:
            `${filename} still contains unfinished placeholder text ("${match[0]}"). ` +
            'Replace it with the real value or remove it.',
        },
      ];
    }
  }
  return [];
}

/** Minimal `*`-only glob match against a bare filename. */
function matchesGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Coerce a parsed JSON row into the string map the rule checks use. */
function normalizeJsonRow(row: unknown): Record<string, string> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value === null || value === undefined ? '' : String(value);
  }
  return normalized;
}

/** The header cells of the first Markdown pipe-table row, if any. */
function parseMarkdownHeader(text: string): string[] | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      return trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
    }
  }
  return undefined;
}

/**
 * Parse RFC 4180-shaped CSV: quoted fields, doubled quotes inside them, and
 * newlines inside quotes. Returns undefined only for structurally broken
 * input (an unterminated quoted field) or an empty file.
 */
function parseCsv(
  text: string,
): { header: string[]; rows: Array<Record<string, string>> } | undefined {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Treat CRLF as one terminator.
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (inQuotes) return undefined;
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((entry) => entry.some((cell) => cell !== ''));
  const header = nonEmpty.shift();
  if (header === undefined) return undefined;

  return {
    header,
    rows: nonEmpty.map((cells) => {
      const row: Record<string, string> = {};
      header.forEach((name, position) => {
        row[name] = cells[position] ?? '';
      });
      return row;
    }),
  };
}

// --- T7: table rendering and completeness -----------------------------------

/**
 * Render every table output the contract declares, writing each through
 * `writeArtifact` so the manifest records its hash.
 *
 * Called at submission (and, best-effort, at incomplete finalization) — never
 * during ordinary work. Rendering only at the boundary is what keeps a
 * half-built table from being published and then graded.
 *
 * @param completionStatus - `complete` at submission; `partial` when
 *   preserving an unverified run, which keeps the requested-output role while
 *   marking the file as not fully satisfying its requirement
 * @returns one failure per table that could not be rendered; an empty array
 *   when every table was written
 */
export function renderTableOutputs(
  runDir: string,
  contract: OutputContract,
  tables: OutputTableStore,
  completionStatus: 'complete' | 'partial' = 'complete',
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  for (const output of contract.outputs) {
    if (output.kind !== 'table') continue;
    try {
      const rendered = renderOutputTable(output, tables.table(output.id));
      writeArtifact(runDir, `${ARTIFACTS_DIR}/${output.filename}`, Buffer.from(rendered, 'utf8'), {
        roles: ['requested_output'],
        completionStatus,
      });
    } catch (error) {
      failures.push({
        outputId: output.id,
        code: 'table_render_failed',
        message: `${output.filename} could not be rendered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  return failures;
}

/**
 * Every count-ruled table must carry evidence-backed completeness proof.
 *
 * A row-count rule is a claim about a POPULATION, not about how many rows
 * happen to be stored — so the store's own row count can never satisfy it.
 * Without this check a run could declare "exactly 12", collect 12 rows it
 * happened to find, and pass mechanically while proving nothing.
 */
export function validateTableCompleteness(
  contract: OutputContract,
  tables: OutputTableStore,
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  for (const output of contract.outputs) {
    if (output.kind !== 'table') continue;
    const countRuled = output.rules.some(
      (rule) => rule.type === 'exact_row_count' || rule.type === 'minimum_row_count',
    );
    if (!countRuled) continue;

    const completeness = tables.table(output.id).completeness;
    if (completeness === undefined) {
      failures.push({
        outputId: output.id,
        code: 'missing_completeness_evidence',
        message:
          `${output.filename} declares a row-count rule, which is a claim about the whole ` +
          'population. Record how you established it with set_table_completeness — the ' +
          'number of rows found cannot prove the number that exist.',
      });
    }
  }
  return failures;
}

/**
 * Every row's cited evidence must still resolve.
 *
 * Evidence can stop resolving between the upsert and the submission (a
 * rewritten record, a store rebuilt mid-run), and a row whose proof has
 * evaporated is exactly as unproven as one that never had any.
 */
export function validateEvidenceReferences(
  contract: OutputContract,
  tables: OutputTableStore,
  evidenceExists: (evidenceId: string) => boolean,
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  for (const output of contract.outputs) {
    if (output.kind !== 'table') continue;
    const table = tables.table(output.id);
    for (const row of table.rows) {
      const dangling = row.evidenceIds.filter((id) => !evidenceExists(id));
      if (dangling.length > 0) {
        failures.push({
          outputId: output.id,
          code: 'dangling_evidence',
          message:
            `${output.filename} row "${row.rowId}" cites evidence that no longer resolves: ` +
            `${dangling.join(', ')}.`,
        });
      }
    }
    for (const id of table.completeness?.evidenceIds ?? []) {
      if (!evidenceExists(id)) {
        failures.push({
          outputId: output.id,
          code: 'dangling_completeness_evidence',
          message: `${output.filename} completeness evidence cites unresolvable id "${id}".`,
        });
      }
    }
  }
  return failures;
}

/**
 * Every contract-bound document output must have been produced by
 * `write_document`, not hand-written with `write_file`.
 *
 * The evidence is the marked source: `write_document` always persists
 * `scratch/documents/<outputId>/source.md` alongside the published file, and
 * nothing else does. A published document with no corresponding source entry
 * was therefore written by hand, which means its evidence markers were never
 * parsed, its citation policy was never enforced, and its required sections
 * were never checked against the contract.
 *
 * Without this check, `write_file` is a hole straight through the entire
 * document pipeline: the model could satisfy a document requirement with
 * unverified prose and the code checks would see a non-empty file and pass it.
 */
export function validateDocumentOutputs(
  runDir: string,
  contract: OutputContract,
): CompletionFailure[] {
  const failures: CompletionFailure[] = [];
  const recorded = new Set(
    publishedOrScratchFilenames(runDir).map((filename) => filename),
  );

  for (const output of contract.outputs) {
    if (output.kind !== 'document') continue;
    const publishedPath = `${ARTIFACTS_DIR}/${output.filename}`;
    if (!recorded.has(publishedPath)) continue; // absence is reported elsewhere

    const sourcePath = `${SCRATCH_DIR}/documents/${output.id}/source.md`;
    if (!recorded.has(sourcePath)) {
      failures.push({
        outputId: output.id,
        code: 'document_not_rendered',
        message:
          `${output.filename} exists but has no evidence-marked source at ${sourcePath}, ` +
          'so it was hand-written rather than produced by write_document. Its citations ' +
          'were never checked. Re-create it with write_document, which parses the ' +
          '[evidence:E1] markers and enforces this output’s citation policy.',
      });
    }
  }
  return failures;
}

/** Every filename the manifest records, published or scratch. */
function publishedOrScratchFilenames(runDir: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8'),
    ) as Manifest;
    return (manifest.artifacts ?? []).map((entry) => entry.filename);
  } catch {
    return [];
  }
}
