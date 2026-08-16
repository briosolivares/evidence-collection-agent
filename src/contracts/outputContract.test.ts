import { describe, expect, it } from 'vitest';

import {
  outputContractSchema,
  validateOutputContract,
  type OutputContract,
  type OutputSpec,
} from './outputContract.js';

// Every cross-field rule lives in validateOutputContract() rather than in
// the Zod schema (refinements are dropped by z.toJSONSchema(), so the model
// would never see them). These tests therefore drive the validator, not the
// schema, for anything beyond raw shape.

/** A minimal valid table output. */
function tableOutput(overrides: Partial<Extract<OutputSpec, { kind: 'table' }>> = {}): OutputSpec {
  return {
    id: 'roster',
    kind: 'table',
    filename: 'roster.csv',
    format: 'csv',
    columns: [
      { name: 'name', required: true, type: 'string' },
      { name: 'url', required: false, type: 'url' },
    ],
    rules: [],
    ...overrides,
  } as OutputSpec;
}

function contract(outputs: OutputSpec[] = [tableOutput()]): OutputContract {
  return { outputs } as OutputContract;
}

function validate(c: OutputContract = contract()) {
  return validateOutputContract(c);
}

function errorsOf(result: ReturnType<typeof validateOutputContract>): string[] {
  if (result.ok) throw new Error('expected the contract to be rejected');
  return result.errors;
}

describe('outputContractSchema shape', () => {
  it('requires at least one output and at least one column per table', () => {
    expect(outputContractSchema.safeParse({ outputs: [] }).success).toBe(false);
    expect(
      outputContractSchema.safeParse(contract([tableOutput({ columns: [] })])).success,
    ).toBe(false);
  });

  it('rejects unknown keys anywhere in the contract', () => {
    expect(
      outputContractSchema.safeParse({ outputs: [tableOutput()], surprise: true }).success,
    ).toBe(false);
    expect(
      validateOutputContract({ outputs: [tableOutput()], extra: 1 }).ok,
    ).toBe(false);
  });

  it('applies document evidence defaults so the stored form is always explicit', () => {
    const result = validate(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
        } as OutputSpec,
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const doc = result.contract.outputs[0] as Extract<OutputSpec, { kind: 'document' }>;
    expect(doc.evidenceRequirement).toBe('at_least_one');
    expect(doc.evidencePresentation).toBe('hidden');
  });
});

describe('validateOutputContract cross-field rules', () => {
  it('accepts a well-formed immutable contract', () => {
    const result = validate();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.contract).toEqual(contract());
  });

  it('rejects duplicate output ids', () => {
    const result = validate(contract([tableOutput(), tableOutput({ filename: 'other.csv' })]));
    expect(errorsOf(result).join('\n')).toMatch(/duplicate output id/);
  });

  it('rejects two outputs claiming the same file', () => {
    const result = validate(
      contract([tableOutput(), tableOutput({ id: 'second' })]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/roster\.csv/);
  });

  it.each([
    ['a directory component', 'sub/roster.csv'],
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', '../roster.csv'],
    ['a bare dot', '.'],
    ['a parent dir', '..'],
    ['the manifest', 'manifest.json'],
    ['the metrics file', 'metrics.json'],
    ['the transcript', 'transcript.jsonl'],
  ])('rejects an unsafe filename: %s', (_label, filename) => {
    expect(errorsOf(validate(contract([tableOutput({ filename })]))).length).toBeGreaterThan(0);
  });

  it('rejects a filename carrying a control character', () => {
    const result = validate(contract([tableOutput({ filename: 'roster\u0001.csv' })]));
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('rejects duplicate table columns', () => {
    const result = validate(
      contract([
        tableOutput({
          columns: [
            { name: 'name', required: true, type: 'string' },
            { name: 'name', required: false, type: 'string' },
          ],
        }),
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/name/);
  });

  it('rejects a rule naming an undeclared column', () => {
    const result = validate(
      contract([tableOutput({ rules: [{ type: 'unique', columns: ['missing'] }] as never })]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/missing/);
  });

  it('rejects a minimum row count above an exact count', () => {
    const result = validate(
      contract([
        tableOutput({
          rules: [
            { type: 'exact_row_count', value: 5 },
            { type: 'minimum_row_count', value: 9 },
          ] as never,
        }),
      ]),
    );
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('rejects a non-positive or non-integer count', () => {
    for (const count of [0, -3, 2.5]) {
      const result = validate(
        contract([tableOutput({ rules: [{ type: 'exact_row_count', value: count }] as never })]),
      );
      expect(errorsOf(result).length).toBeGreaterThan(0);
    }
  });

  it('rejects a download constrained by nothing', () => {
    const result = validate(
      contract([
        { id: 'dl', kind: 'download', count: { minimum: 1 } } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/download/i);
  });

  it('rejects per-section evidence with no required sections', () => {
    const result = validate(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
          evidenceRequirement: 'per_required_section',
        } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).join('\n')).toMatch(/section/i);
  });

  it('rejects footnoted citations on a document requiring no evidence', () => {
    const result = validate(
      contract([
        {
          id: 'report',
          kind: 'document',
          filename: 'report.md',
          format: 'markdown',
          evidenceRequirement: 'none',
          evidencePresentation: 'footnotes',
        } as OutputSpec,
      ]),
    );
    expect(errorsOf(result).length).toBeGreaterThan(0);
  });

  it('reports every problem at once so one correction can fix them all', () => {
    const result = validate(
      contract([
        tableOutput({ filename: 'sub/roster.csv' }),
        tableOutput({ id: 'roster', filename: 'manifest.json' }),
      ]),
    );
    // Duplicate id, unsafe path, and reserved name are all named together.
    expect(errorsOf(result).length).toBeGreaterThanOrEqual(3);
  });
});
