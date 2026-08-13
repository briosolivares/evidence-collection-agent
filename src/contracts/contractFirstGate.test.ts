import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../tools/pipeline.js';
import {
  BLOCKED_BY_INVALID_CONTRACT,
  blockedByInvalidContractResults,
  decideContractGate,
  OUTPUT_CONTRACT_REQUIRED,
  SET_OUTPUT_CONTRACT,
} from './contractFirstGate.js';

function call(name: string, id = `call_${name}`): ToolCall {
  return { id, name, input: {} };
}

describe('decideContractGate', () => {
  it('executes freely once a contract exists', () => {
    expect(decideContractGate([call('navigate'), call('write_file')], true)).toEqual({
      kind: 'execute',
    });
  });

  it('executes a response whose first call states the contract', () => {
    expect(
      decideContractGate([call(SET_OUTPUT_CONTRACT), call('navigate')], false),
    ).toEqual({ kind: 'execute' });
  });

  it('refuses every call when no contract exists and none is proposed', () => {
    const calls = [call('navigate'), call('screenshot'), call('write_file')];
    const decision = decideContractGate(calls, false);

    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') throw new Error('unreachable');
    // One result per attempted call, in the model's own order — the API
    // requires every tool_use answered.
    expect(decision.results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.id));
    for (const result of decision.results) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain(OUTPUT_CONTRACT_REQUIRED);
      expect(result.content).toContain('Nothing in this response ran');
    }
  });

  it('refuses a response that buries the contract call after other work', () => {
    const calls = [call('navigate'), call(SET_OUTPUT_CONTRACT)];
    const decision = decideContractGate(calls, false);

    expect(decision.kind).toBe('refuse');
    if (decision.kind !== 'refuse') throw new Error('unreachable');
    expect(decision.results).toHaveLength(2);
    // The message says specifically that it must come FIRST, rather than
    // claiming it is missing — the model needs the actionable difference.
    expect(decision.results[0]?.content).toMatch(/FIRST call/);
  });

  it('treats a no-call response as nothing to gate', () => {
    expect(decideContractGate([], false)).toEqual({ kind: 'execute' });
  });
});

describe('blockedByInvalidContractResults', () => {
  it('blocks each following call with the stable code and no execution', () => {
    const rest = [call('navigate'), call('write_file')];
    const results = blockedByInvalidContractResults(rest);

    expect(results.map((r) => r.toolCallId)).toEqual(rest.map((c) => c.id));
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain(BLOCKED_BY_INVALID_CONTRACT);
      expect(result.content).toMatch(/did not run/);
    }
  });

  it('returns nothing when the contract call was the whole response', () => {
    expect(blockedByInvalidContractResults([])).toEqual([]);
  });
});
