import { describe, expect, it } from 'vitest';

import { createRegistry, toApiToolDefs } from '../registry.js';
import {
  durableFinishInputSchema,
  FINISH_TOOL_NAME,
  finishInputSchema,
  finishTool,
  type FinishInput,
} from './finish.js';

const validInput: FinishInput = {
  summary: 'Collected the requested records and published the exact CSV.',
  unresolved: [],
};

describe('finish schema', () => {
  it('is one strict top-level object with exactly the control-call fields', () => {
    const [definition] = toApiToolDefs(createRegistry([finishTool]));

    expect(definition?.name).toBe(FINISH_TOOL_NAME);
    expect(definition?.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'unresolved'],
    });
    expect(Object.keys(finishInputSchema.shape)).toEqual(['summary', 'unresolved']);
    expect(finishInputSchema.parse(validInput)).toEqual(validInput);
  });

  it('requires one nonblank summary and rejects extra fields', () => {
    for (const invalid of [
      {},
      { summary: '  ' },
      { summary: 'done', limitations: ['  '] },
      { ...validInput, artifacts: ['artifacts/a.csv'] },
      { ...validInput, success: true },
    ]) {
      expect(finishInputSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      finishInputSchema.safeParse({ summary: 'done', unresolved: [] }).success,
    ).toBe(true);
    expect(
      finishInputSchema.safeParse({
        summary: 'Published useful partial work.',
        unresolved: [
          {
            requirement: 'Collect the protected record.',
            reason: 'The source requires unavailable account access.',
            attempts: ['Tried the public record endpoint.'],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      finishInputSchema.safeParse({
        summary: 'Partial work.',
        unresolved: [{ requirement: 'Record', reason: 'Blocked', attempts: ['  '] }],
      }).success,
    ).toBe(false);
  });

  it('normalizes historical checkpoint inputs to the current shape', () => {
    expect(
      durableFinishInputSchema.parse({
        summary: 'Published the requested report.',
        limitations: ['The source required an unavailable account.'],
      }),
    ).toEqual({ summary: 'Published the requested report.', unresolved: [] });
    expect(
      durableFinishInputSchema.parse({
        summary: 'Published the requested report.',
        artifacts: ['artifacts/report.csv'],
        limitations: [],
      }),
    ).toEqual({ summary: 'Published the requested report.', unresolved: [] });
  });
});

describe('finish control definition', () => {
  it('is exclusive and fails loudly if generic dispatch reaches execute', () => {
    expect(finishTool.getAccess(validInput)).toEqual({
      reads: [],
      writes: [],
      exclusive: true,
    });
    expect(() => finishTool.execute(validInput, { runDir: '/unused' })).toThrow(
      /must be intercepted by the worker loop/,
    );
  });
});
