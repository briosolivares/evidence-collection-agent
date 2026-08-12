import { describe, expect, it } from 'vitest';

import { parseEvalArgs } from './cliArgs.js';

describe('parseEvalArgs', () => {
  it('parses the standard invocation and comma-separated task lists', () => {
    expect(parseEvalArgs(['--tasks', 'stub', '--k', '2'])).toEqual({
      tasks: ['stub'],
      k: 2,
      toolProfile: 'atomic',
    });
    expect(parseEvalArgs(['--tasks', 'hacker_news,edgar', '--k=3'])).toEqual({
      tasks: ['hacker_news', 'edgar'],
      k: 3,
      toolProfile: 'atomic',
    });
  });

  it('defaults k to 1 when --k is absent', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).k).toBe(1);
  });

  it('accepts both tool profiles and defaults to atomic', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).toolProfile).toBe('atomic');
    expect(
      parseEvalArgs(['--tasks', 'stub', '--tool-profile', 'batch-enabled']).toolProfile,
    ).toBe('batch-enabled');
    expect(parseEvalArgs(['--tasks=stub', '--tool-profile=atomic']).toolProfile).toBe('atomic');
    expect(() => parseEvalArgs(['--tasks', 'stub', '--tool-profile', 'other'])).toThrow(
      /atomic.*batch-enabled/,
    );
  });

  it('rejects a k that is not a positive integer', () => {
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', '0'])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', '1.5'])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', 'three'])).toThrow(/positive integer/);
  });

  it('rejects missing --tasks, an empty task list, and unknown flags', () => {
    expect(() => parseEvalArgs([])).toThrow(/--tasks is required/);
    expect(() => parseEvalArgs(['--tasks', ','])).toThrow(/at least one/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--verbose'])).toThrow(/unknown argument/);
    expect(() => parseEvalArgs(['--tasks'])).toThrow(/missing value/);
  });
});
