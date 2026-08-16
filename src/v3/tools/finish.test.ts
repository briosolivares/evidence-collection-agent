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
  limitations: [],
};

describe('finish schema', () => {
  it('is one strict top-level object with exactly the control-call fields', () => {
    const [definition] = toApiToolDefs(createRegistry([finishTool]));

    expect(definition?.name).toBe(FINISH_TOOL_NAME);
    expect(definition?.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'limitations'],
    });
    expect(Object.keys(finishInputSchema.shape)).toEqual([
      'summary',
      'limitations',
    ]);
    expect(finishInputSchema.parse(validInput)).toEqual(validInput);
  });

  it('requires explicit, nonblank, duplicate-free values and rejects extra fields', () => {
    for (const invalid of [
      { summary: 'done' },
      { summary: '  ', limitations: [] },
      { summary: 'done', limitations: ['  '] },
      {
        summary: 'done',
        limitations: ['blocked', 'blocked'],
      },
      { ...validInput, artifacts: ['artifacts/a.csv'] },
      { ...validInput, success: true },
    ]) {
      expect(finishInputSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      finishInputSchema.safeParse({
        summary: 'No output could be claimed because access remained blocked.',
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
