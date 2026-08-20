import { describe, expect, it } from 'vitest';

import { parseEvalArgs } from './cliArgs.js';

describe('parseEvalArgs', () => {
  it('parses the standard invocation and comma-separated task lists', () => {
    expect(parseEvalArgs(['--tasks', 'stub', '--k', '2'])).toEqual({
      tasks: ['stub'],
      k: 2,
      concurrency: 3,
      skipLoginCheck: false,
    });
    expect(parseEvalArgs(['--tasks', 'hacker_news,edgar', '--k=3'])).toEqual({
      tasks: ['hacker_news', 'edgar'],
      k: 3,
      concurrency: 3,
      skipLoginCheck: false,
    });
  });

  it('rejects the retired worker-contract selector', () => {
    expect(() => parseEvalArgs(['--tasks', 'stub', '--contract-author', 'worker'])).toThrow(
      /unknown argument/,
    );
  });

  it('defaults k to 1 when --k is absent', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).k).toBe(1);
  });

  it('accepts a positive concurrency and defaults to 3', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).concurrency).toBe(3);
    expect(parseEvalArgs(['--tasks', 'stub', '--concurrency', '5']).concurrency).toBe(5);
    expect(parseEvalArgs(['--tasks=stub', '--concurrency=2']).concurrency).toBe(2);
  });

  it('rejects a k that is not a positive integer', () => {
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', '0'])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', '1.5'])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--k', 'three'])).toThrow(/positive integer/);
  });

  it('rejects a concurrency that is not a positive integer', () => {
    expect(() => parseEvalArgs(['--tasks', 'stub', '--concurrency', '0'])).toThrow(
      /positive integer/,
    );
    expect(() => parseEvalArgs(['--tasks', 'stub', '--concurrency', '1.5'])).toThrow(
      /positive integer/,
    );
    expect(() => parseEvalArgs(['--tasks', 'stub', '--concurrency', 'many'])).toThrow(
      /positive integer/,
    );
    expect(() => parseEvalArgs(['--tasks', 'stub', '--concurrency'])).toThrow(/missing value/);
  });

  it('rejects missing --tasks, an empty task list, and unknown flags', () => {
    expect(() => parseEvalArgs([])).toThrow(/--tasks is required/);
    expect(() => parseEvalArgs(['--tasks', ','])).toThrow(/at least one/);
    expect(() => parseEvalArgs(['--tasks', 'stub', '--verbose'])).toThrow(/unknown argument/);
    expect(() => parseEvalArgs(['--tasks'])).toThrow(/missing value/);
  });
});

describe('--skip-login-check', () => {
  it('defaults to running the login gate', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).skipLoginCheck).toBe(false);
  });

  it('is a bare flag that consumes no value', () => {
    const args = parseEvalArgs(['--tasks', 'stub', '--skip-login-check', '--k', '2']);
    expect(args.skipLoginCheck).toBe(true);
    expect(args.k).toBe(2);
  });
});
