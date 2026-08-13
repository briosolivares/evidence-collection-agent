import { describe, expect, it } from 'vitest';

import { parseEvalArgs } from './cliArgs.js';

describe('parseEvalArgs', () => {
  it('parses the standard invocation and comma-separated task lists', () => {
    expect(parseEvalArgs(['--tasks', 'stub', '--k', '2'])).toEqual({
      tasks: ['stub'],
      k: 2,
      concurrency: 3,
      toolProfile: 'atomic',
      outputContract: false,
      contractAuthor: 'initializer',
    });
    expect(parseEvalArgs(['--tasks', 'hacker_news,edgar', '--k=3'])).toEqual({
      tasks: ['hacker_news', 'edgar'],
      k: 3,
      concurrency: 3,
      toolProfile: 'atomic',
      outputContract: false,
      contractAuthor: 'initializer',
    });
  });

  it('defaults to the prose protocol, since that is still production', () => {
    expect(parseEvalArgs(['--tasks', 'stub']).outputContract).toBe(false);
  });

  it('treats a bare --output-contract as true and accepts the = form both ways', () => {
    expect(parseEvalArgs(['--tasks', 'stub', '--output-contract']).outputContract).toBe(true);
    expect(parseEvalArgs(['--tasks', 'stub', '--output-contract=true']).outputContract).toBe(true);
    expect(parseEvalArgs(['--tasks', 'stub', '--output-contract=false']).outputContract).toBe(
      false,
    );
    expect(() => parseEvalArgs(['--tasks', 'stub', '--output-contract=yes'])).toThrow(
      /"true" or "false"/,
    );
  });

  it('does not let a bare --output-contract swallow the following flag value', () => {
    // The space form is unsupported precisely so this cannot misparse.
    expect(parseEvalArgs(['--tasks', 'stub', '--output-contract', '--k', '2'])).toMatchObject({
      k: 2,
      outputContract: true,
    });
  });

  it('accepts both contract authors and defaults to initializer', () => {
    expect(
      parseEvalArgs(['--tasks', 'stub', '--output-contract', '--contract-author', 'worker'])
        .contractAuthor,
    ).toBe('worker');
    expect(parseEvalArgs(['--tasks', 'stub', '--output-contract=true']).contractAuthor).toBe(
      'initializer',
    );
    expect(() =>
      parseEvalArgs(['--tasks', 'stub', '--output-contract', '--contract-author', 'nobody']),
    ).toThrow(/initializer.*worker/);
  });

  it('rejects --contract-author without --output-contract rather than ignoring it', () => {
    expect(() => parseEvalArgs(['--tasks', 'stub', '--contract-author', 'worker'])).toThrow(
      /requires --output-contract/,
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
