import { describe, expect, it } from 'vitest';

import { createRegistry, toApiToolDefs } from '../../tools/registry.js';
import {
  FINISH_TOOL_NAME,
  finishInputSchema,
  finishTool,
  type FinishInput,
} from './finish.js';

const validInput: FinishInput = {
  summary: 'Collected the requested records and published the exact CSV.',
  artifacts: ['artifacts/records.csv'],
  limitations: [],
};

describe('finish schema', () => {
  it('is one strict top-level object with exactly the control-call fields', () => {
    const [definition] = toApiToolDefs(createRegistry([finishTool]));

    expect(definition?.name).toBe(FINISH_TOOL_NAME);
    expect(definition?.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'artifacts', 'limitations'],
    });
    expect(Object.keys(finishInputSchema.shape)).toEqual([
      'summary',
      'artifacts',
      'limitations',
    ]);
    expect(finishInputSchema.parse(validInput)).toEqual(validInput);
  });

  it('requires explicit, nonblank, duplicate-free values and rejects extra fields', () => {
    for (const invalid of [
      { summary: 'done', artifacts: [] },
      { summary: '  ', artifacts: [], limitations: [] },
      { summary: 'done', artifacts: ['  '], limitations: [] },
      {
        summary: 'done',
        artifacts: ['artifacts/a.csv', 'artifacts/a.csv'],
        limitations: [],
      },
      {
        summary: 'done',
        artifacts: [],
        limitations: ['blocked', 'blocked'],
      },
      { ...validInput, success: true },
    ]) {
      expect(finishInputSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      finishInputSchema.safeParse({
        summary: 'No output could be claimed because access remained blocked.',
        artifacts: [],
        limitations: ['The source required an unavailable account.'],
      }).success,
    ).toBe(true);
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
      /must be intercepted by the v3 worker loop/,
    );
  });
});
