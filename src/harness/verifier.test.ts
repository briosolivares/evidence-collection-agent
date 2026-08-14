import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CallModel, Message, ModelResponse, Usage } from '../loop/messages.js';
import { initManifest } from '../run/artifacts.js';
import {
  REPORT_VERIFICATION_TOOL,
  runVerifier,
  verificationResultSchema,
  VERIFIER_MAX_CONTEXT_TOKENS,
  VERIFIER_SYSTEM_PROMPT,
  type VerifierOutcome,
} from './verifier.js';
import { VERIFIER_MAX_IMAGE_DIMENSION_PX } from './verifierTools.js';

// Hermetic: every verifier response is scripted — no live API, no browser.
// These tests pin the T3 contract: the decision travels ONLY through a
// schema-valid report_verification call, and every other ending fails
// closed as verifier_unavailable rather than as `verified`.

const TASK = 'Collect the widget roster and publish a report.';
const DEFAULT_USAGE: Usage = { input_tokens: 100, output_tokens: 20 };

/** The run's typed contract — a required argument to runVerifier, so every
 * case supplies one; there is no contract-less path to test. */
const CONTRACT = {
  outputs: [{ id: 'roster', kind: 'table', filename: 'roster.csv', format: 'csv' }],
};
const CONTRACTS = { current: CONTRACT, history: [{ revision: 1, contract: CONTRACT }] };

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'verifier-test-'));
  initManifest(runDir, TASK);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function publishArtifact(relName: string, content: string | Buffer): void {
  const dir = join(runDir, 'artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, relName), content);
}

function textResponse(text: string, usage: Usage = DEFAULT_USAGE): ModelResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  usage: Usage = DEFAULT_USAGE,
): ModelResponse {
  return {
    content: calls.map((call) => ({ type: 'tool_use' as const, ...call })),
    stop_reason: 'tool_use',
    usage,
  };
}

function reportResponse(input: unknown, usage: Usage = DEFAULT_USAGE): ModelResponse {
  return toolCallResponse([{ id: 'rep_1', name: 'report_verification', input }], usage);
}

function scriptModel(responses: readonly ModelResponse[]): {
  callModel: CallModel;
  requests: Message[][];
} {
  const requests: Message[][] = [];
  const callModel: CallModel = async (messages) => {
    requests.push(structuredClone(messages) as Message[]);
    const response = responses[requests.length - 1];
    if (response === undefined) {
      throw new Error(`verifier called ${requests.length}x, only ${responses.length} scripted`);
    }
    return response;
  };
  return { callModel, requests };
}

async function verify(responses: readonly ModelResponse[]): Promise<VerifierOutcome> {
  return runVerifier({
    taskText: TASK,
    runDir,
    callModel: scriptModel(responses).callModel,
    contracts: CONTRACTS,
  });
}

describe('verificationResultSchema', () => {
  it('accepts verified only with an empty findings array', () => {
    expect(verificationResultSchema.safeParse({ status: 'verified', findings: [] }).success).toBe(
      true,
    );
    // A "verified" carrying findings is contradictory — rejected outright.
    expect(
      verificationResultSchema.safeParse({
        status: 'verified',
        findings: [{ area: 'output', code: 'x', message: 'y' }],
      }).success,
    ).toBe(false);
  });

  it('requires at least one complete finding for needs_correction', () => {
    expect(
      verificationResultSchema.safeParse({ status: 'needs_correction', findings: [] }).success,
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [{ area: 'output', code: 'missing_column', message: 'id column absent' }],
      }).success,
    ).toBe(true);
    // Missing message, empty code, and unknown area all fail.
    for (const finding of [
      { area: 'output', code: 'missing_column' },
      { area: 'output', code: '', message: 'm' },
      { area: 'nonsense', code: 'c', message: 'm' },
    ]) {
      expect(
        verificationResultSchema.safeParse({ status: 'needs_correction', findings: [finding] })
          .success,
      ).toBe(false);
    }
  });

  it('rejects an unknown status and extra properties', () => {
    expect(verificationResultSchema.safeParse({ status: 'done', findings: [] }).success).toBe(false);
    expect(
      verificationResultSchema.safeParse({ status: 'verified', findings: [], extra: 1 }).success,
    ).toBe(false);
  });

  it('offers report_verification with both statuses in its API schema', () => {
    expect(REPORT_VERIFICATION_TOOL.name).toBe('report_verification');
    expect(JSON.stringify(REPORT_VERIFICATION_TOOL.input_schema)).toContain('needs_correction');
  });
});

describe('runVerifier typed reporting', () => {
  it('returns verified from a schema-valid report', async () => {
    publishArtifact('report.md', '# Widgets\n- one\n');
    await expect(verify([reportResponse({ status: 'verified', findings: [] })])).resolves.toEqual({
      status: 'verified',
      findings: [],
    });
  });

  it('returns needs_correction with its findings intact', async () => {
    const outcome = await verify([
      reportResponse({
        status: 'needs_correction',
        findings: [
          {
            area: 'evidence',
            code: 'unproven_claim',
            message: 'The widget count has no supporting evidence.',
            outputId: 'report',
            evidenceIds: ['E1'],
          },
        ],
      }),
    ]);
    expect(outcome).toEqual({
      status: 'needs_correction',
      findings: [
        {
          area: 'evidence',
          code: 'unproven_claim',
          message: 'The widget count has no supporting evidence.',
          outputId: 'report',
          evidenceIds: ['E1'],
        },
      ],
    });
  });

  it('runs read-only inspection calls before the report', async () => {
    publishArtifact('report.md', 'id,name\n1,widget\n');
    const script = scriptModel([
      toolCallResponse([
        { id: 'r1', name: 'read_file', input: { file_path: 'artifacts/report.md' } },
      ]),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    const outcome = await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    expect(outcome.status).toBe('verified');
    // The second request carries the real file content as a tool result.
    expect(JSON.stringify(script.requests[1])).toContain('1,widget');
  });
});

describe('runVerifier fails closed', () => {
  it('gives ordinary DONE prose no control-flow meaning', async () => {
    // Two prose responses: one repair, then still no report → unavailable.
    // The word DONE must never verify a run.
    const outcome = await verify([textResponse('DONE'), textResponse('DONE, truly.')]);
    expect(outcome.status).toBe('verifier_unavailable');
  });

  it('treats CONTINUE prose as no decision at all', async () => {
    const outcome = await verify([
      textResponse('CONTINUE: the report is missing a column'),
      textResponse('CONTINUE again'),
    ]);
    expect(outcome.status).toBe('verifier_unavailable');
  });

  it('repairs a prose response once, then accepts a valid report', async () => {
    const script = scriptModel([
      textResponse('I think everything looks fine.'),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    const outcome = await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    expect(outcome).toEqual({ status: 'verified', findings: [] });
    // The repair turn names the protocol violation to the same session.
    expect(JSON.stringify(script.requests[1])).toContain('report_verification');
  });

  it('repairs one schema-invalid report, then accepts the corrected one', async () => {
    const script = scriptModel([
      reportResponse({ status: 'verified', findings: [{ area: 'output', code: 'c', message: 'm' }] }),
      reportResponse({ status: 'needs_correction', findings: [{ area: 'output', code: 'c', message: 'm' }] }),
    ]);
    const outcome = await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    expect(outcome.status).toBe('needs_correction');
    expect(JSON.stringify(script.requests[1])).toContain('failed validation');
  });

  it('a second invalid report is verifier_unavailable, never verified', async () => {
    const invalid = reportResponse({ status: 'verified', findings: ['not a finding'] });
    const outcome = await verify([invalid, invalid]);
    expect(outcome.status).toBe('verifier_unavailable');
    if (outcome.status !== 'verifier_unavailable') throw new Error('unreachable');
    expect(outcome.reason).toContain('invalid report_verification input');
  });

  it('rejects a report mixed with another tool call', async () => {
    const mixed = toolCallResponse([
      { id: 'rep_1', name: 'report_verification', input: { status: 'verified', findings: [] } },
      { id: 'r2', name: 'read_file', input: { file_path: 'artifacts/report.md' } },
    ]);
    const outcome = await verify([mixed, mixed]);
    expect(outcome.status).toBe('verifier_unavailable');
    if (outcome.status !== 'verifier_unavailable') throw new Error('unreachable');
    expect(outcome.reason).toContain('only tool call');
  });

  it('rejects two report calls in one response', async () => {
    const doubled = toolCallResponse([
      { id: 'rep_1', name: 'report_verification', input: { status: 'verified', findings: [] } },
      { id: 'rep_2', name: 'report_verification', input: { status: 'verified', findings: [] } },
    ]);
    const outcome = await verify([doubled, doubled]);
    expect(outcome.status).toBe('verifier_unavailable');
    if (outcome.status !== 'verifier_unavailable') throw new Error('unreachable');
    expect(outcome.reason).toContain('more than one');
  });

  it('maps a thrown model call (refusal, token limit, transport) to verifier_unavailable', async () => {
    const failing: CallModel = async () => {
      throw new Error('400 refusal from the provider');
    };
    const outcome = await runVerifier({ taskText: TASK, runDir, callModel: failing, contracts: CONTRACTS });
    expect(outcome.status).toBe('verifier_unavailable');
    if (outcome.status !== 'verifier_unavailable') throw new Error('unreachable');
    expect(outcome.reason).toContain('400 refusal');
  });

  it("propagates an AbortError — cancellation is the caller's", async () => {
    const aborting: CallModel = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(
      runVerifier({ taskText: TASK, runDir, callModel: aborting, contracts: CONTRACTS }),
    ).rejects.toThrow('aborted');
  });

  it('forces a report once the context ceiling trips, and accepts it', async () => {
    const overCeiling: Usage = {
      input_tokens: VERIFIER_MAX_CONTEXT_TOKENS + 1,
      output_tokens: 10,
    };
    const script = scriptModel([
      toolCallResponse(
        [{ id: 'r1', name: 'read_file', input: { file_path: 'artifacts/report.md' } }],
        overCeiling,
      ),
      reportResponse({
        status: 'needs_correction',
        findings: [{ area: 'completeness', code: 'unverified', message: 'Budget exhausted.' }],
      }),
    ]);
    const outcome = await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    expect(outcome.status).toBe('needs_correction');
    // The dangling inspection call is closed and the report demanded.
    const forced = JSON.stringify(script.requests[1]);
    expect(forced).toContain('inspection budget is exhausted');
  });

  it('still-inspecting after the forced demand is verifier_unavailable', async () => {
    const overCeiling: Usage = {
      input_tokens: VERIFIER_MAX_CONTEXT_TOKENS + 1,
      output_tokens: 10,
    };
    const keepReading = toolCallResponse(
      [{ id: 'r1', name: 'read_file', input: { file_path: 'artifacts/report.md' } }],
      overCeiling,
    );
    const outcome = await verify([keepReading, keepReading]);
    expect(outcome.status).toBe('verifier_unavailable');
  });

});

describe('runVerifier typed-contract input', () => {
  it('shows the current contract and flags a single-revision history', async () => {
    const script = scriptModel([reportResponse({ status: 'verified', findings: [] })]);
    await runVerifier({
      taskText: TASK,
      runDir,
      callModel: script.callModel,
      contracts: CONTRACTS,
    });

    const opening = JSON.stringify(script.requests[0]);
    expect(opening).toContain('# Output contract (current revision)');
    expect(opening).toContain('roster.csv');
    expect(opening).toContain('never changed');
    // The original task is always present: task vs. contract is the check
    // that stops a mis-stated contract validating its own mistake.
    expect(opening).toContain(TASK);
  });

  it('shows the full revision history with its basis when the contract changed', async () => {
    const history = [
      { revision: 1, contract: CONTRACT },
      {
        revision: 2,
        basis: { kind: 'evidence_discovery', summary: 'Exact roster size found.', evidenceIds: ['E1'] },
        contract: CONTRACT,
      },
    ];
    const script = scriptModel([reportResponse({ status: 'verified', findings: [] })]);
    await runVerifier({
      taskText: TASK,
      runDir,
      callModel: script.callModel,
      contracts: { current: CONTRACT, history },
    });

    const opening = JSON.stringify(script.requests[0]);
    expect(opening).toContain('# Contract revision history');
    // The basis is what lets the verifier tell strengthening from drift.
    expect(opening).toContain('evidence_discovery');
    expect(opening).toContain('Exact roster size found.');
  });

  it('states code-settled facts as settled, and says nothing when there are none', async () => {
    const script = scriptModel([reportResponse({ status: 'verified', findings: [] })]);
    await runVerifier({
      taskText: TASK,
      runDir,
      callModel: script.callModel,
      contracts: CONTRACTS,
      settled: [
        {
          outputId: 'roster',
          code: 'row_count',
          statement: 'artifacts/roster.csv contains exactly 5 data rows.',
        },
      ],
    });

    const opening = JSON.stringify(script.requests[0]);
    expect(opening).toContain('Already established by code');
    expect(opening).toContain('roster: artifacts/roster.csv contains exactly 5 data rows.');

    // No facts, no section — an empty heading would read as "code found
    // nothing", which is a different claim from "code was not consulted".
    const bare = scriptModel([reportResponse({ status: 'verified', findings: [] })]);
    await runVerifier({
      taskText: TASK,
      runDir,
      callModel: bare.callModel,
      contracts: CONTRACTS,
    });
    expect(JSON.stringify(bare.requests[0])).not.toContain('Already established by code');
  });

});

describe('runVerifier evidence scope and screenshots', () => {
  it('refuses reads outside published evidence without executing them', async () => {
    writeFileSync(join(runDir, 'scratch', 'notes.md'), 'private worker notes');
    const script = scriptModel([
      toolCallResponse([
        { id: 'r1', name: 'read_file', input: { file_path: 'scratch/notes.md' } },
      ]),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    const feedback = JSON.stringify(script.requests[1]);
    expect(feedback).toContain("Outside the verifier's evidence scope");
    expect(feedback).not.toContain('private worker notes');
  });

  it('reads a cited evidence record, which lives under scratch/', async () => {
    // The other half of the same boundary: a typed row cites E1 and the only
    // record of what E1 captured is scratch/evidence/E1.json. Refusing it
    // made every evidence-cited row unprovable by construction — the
    // verifier was required to check facts against evidence and forbidden
    // from reading the evidence.
    const evidenceDir = join(runDir, 'scratch', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, 'E1.json'),
      JSON.stringify({ id: 'E1', detail: { text: 'Widget A — 412 units' } }),
    );
    const script = scriptModel([
      toolCallResponse([
        { id: 'r1', name: 'read_file', input: { file_path: 'scratch/evidence/E1.json' } },
      ]),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    const feedback = JSON.stringify(script.requests[1]);
    expect(feedback).not.toContain("Outside the verifier's evidence scope");
    expect(feedback).toContain('Widget A');
  });

  it('returns a published PNG as an image block for visual review', async () => {
    publishArtifact('shot.png', pngBytes(800, 600));
    const script = scriptModel([
      toolCallResponse([
        { id: 'r1', name: 'read_file', input: { file_path: 'artifacts/shot.png' } },
      ]),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    const message = script.requests[1]?.[2];
    const block = (message?.content[0] as { content: unknown }).content as Array<{ type: string }>;
    expect(block.map((entry) => entry.type)).toEqual(['text', 'image']);
  });

  it('refuses an over-dimension image instead of 400-failing the request', async () => {
    publishArtifact('tall.png', pngBytes(1280, VERIFIER_MAX_IMAGE_DIMENSION_PX + 1));
    const script = scriptModel([
      toolCallResponse([
        { id: 'r1', name: 'read_file', input: { file_path: 'artifacts/tall.png' } },
      ]),
      reportResponse({ status: 'verified', findings: [] }),
    ]);
    await runVerifier({ taskText: TASK, runDir, callModel: script.callModel, contracts: CONTRACTS });

    expect(JSON.stringify(script.requests[1])).toContain('Image too large to view');
  });
});

/** Minimal PNG: real signature + IHDR carrying the given dimensions —
 * enough for the header-only dimension parser under test. */
function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8); // IHDR data length
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe('VERIFIER_SYSTEM_PROMPT', () => {
  // Both of these cost real correction cycles in live runs, and neither is
  // enforceable in code: whether a column holds the field the contract named,
  // and whether a finding is worth a cycle, are exactly the judgments the
  // verifier exists to make. The prompt is the only place they can be stated,
  // so these assertions pin the direction rather than the wording.
  it('refuses a proxy field in both directions', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain(
      'A named field means that field, not a near neighbour.',
    );
    // Accepting an adjacent value.
    expect(VERIFIER_SYSTEM_PROMPT).toContain('does not satisfy the field');
    // Demanding a substitute the contract never named.
    expect(VERIFIER_SYSTEM_PROMPT).toContain(
      'Never propose, request, or accept a substitute column',
    );
    expect(VERIFIER_SYSTEM_PROMPT).toContain(
      'redesigning the deliverable rather than verifying it',
    );
  });

  it('spends correction cycles only on unmet criteria and unevidenced claims', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain(
      'A finding must name a contract criterion that is not met, or a claim that is not evidenced.',
    );
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Do not report one for anything the contract does not require');
    expect(VERIFIER_SYSTEM_PROMPT).toContain(
      'the verdict is "verified" even when you can imagine a better deliverable',
    );
  });

  it('describes one contract form, not two', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain('typed output contract together with its full revision history');
    expect(VERIFIER_SYSTEM_PROMPT).not.toContain('INTENT.md');
    expect(VERIFIER_SYSTEM_PROMPT).not.toContain('CONTRACT.md');
  });
});
