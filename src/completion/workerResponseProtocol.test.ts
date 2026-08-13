import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../tools/pipeline.js';
import {
  SUBMIT_FOR_VERIFICATION,
  validateWorkerResponse,
} from './workerResponseProtocol.js';

function call(name: string, id = `call_${name}`): ToolCall {
  return { id, name, input: {} };
}

describe('validateWorkerResponse', () => {
  it('treats ordinary tool calls as work', () => {
    const calls = [call('navigate'), call('write_file')];
    expect(validateWorkerResponse(calls)).toEqual({ kind: 'work', calls });
  });

  it('accepts a lone submission', () => {
    const submission = call(SUBMIT_FOR_VERIFICATION);
    expect(validateWorkerResponse([submission])).toEqual({
      kind: 'submit',
      call: submission,
    });
  });

  it('refuses a no-tool response instead of completing the run', () => {
    // The old implicit completion: saying nothing used to finish a run.
    const disposition = validateWorkerResponse([], 'I have gathered everything needed.');
    expect(disposition.kind).toBe('invalid');
    if (disposition.kind !== 'invalid') throw new Error('unreachable');
    expect(disposition.feedback).toContain(SUBMIT_FOR_VERIFICATION);
    // Nothing to answer: there were no calls.
    expect(disposition.results).toEqual([]);
  });

  it('names the claim when a no-tool response asserts it is finished', () => {
    const disposition = validateWorkerResponse([], 'All done — the report is complete.');
    if (disposition.kind !== 'invalid') throw new Error('unreachable');
    expect(disposition.feedback).toMatch(/claimed the work was finished/);
  });

  it('gives generic feedback when a no-tool response makes no completion claim', () => {
    const disposition = validateWorkerResponse([], 'Let me think about the structure.');
    if (disposition.kind !== 'invalid') throw new Error('unreachable');
    expect(disposition.feedback).toMatch(/made no tool call/);
  });

  it('rejects submission mixed with any other call, executing nothing', () => {
    const calls = [call(SUBMIT_FOR_VERIFICATION), call('write_file')];
    const disposition = validateWorkerResponse(calls);

    expect(disposition.kind).toBe('invalid');
    if (disposition.kind !== 'invalid') throw new Error('unreachable');
    expect(disposition.feedback).toMatch(/ONLY tool call/);
    // Every attempted call is answered so the conversation stays valid, and
    // each result says plainly that it did not run.
    expect(disposition.results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.id));
    for (const result of disposition.results) {
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Not executed/);
    }
  });

  it('rejects two submissions in one response', () => {
    const disposition = validateWorkerResponse([
      call(SUBMIT_FOR_VERIFICATION, 's1'),
      call(SUBMIT_FOR_VERIFICATION, 's2'),
    ]);
    expect(disposition.kind).toBe('invalid');
  });

  it('rejects submission even when it comes last', () => {
    // Order must not matter: a write whose effects land after the run has
    // claimed completion is exactly what exclusivity prevents.
    const disposition = validateWorkerResponse([
      call('write_file'),
      call(SUBMIT_FOR_VERIFICATION),
    ]);
    expect(disposition.kind).toBe('invalid');
  });
});
