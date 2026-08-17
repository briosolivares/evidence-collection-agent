import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../loop/messages.js';
import type {
  AcceptedModelResponse,
  ModelDriver,
  ModelGenerateOptions,
} from '../../model/modelDriver.js';
import {
  initManifest,
  readManifest,
  verifyManifestFiles,
} from '../../run/artifacts.js';
import { createRunBudgetTracker } from '../../run/runBudget.js';
import { createV3ToolRegistry } from '../tools/index.js';
import {
  V3_NO_TOOL_CONTINUATION,
  captureV3WorkerSessionSnapshot,
  createV3WorkerSession,
  restoreV3WorkerSession,
  runV3WorkerSession,
  runV3WorkerTurn,
} from './workerSession.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-session-integration-'));
  initManifest(runDir, 'publish a two-column CSV report');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function accepted(
  content: AcceptedModelResponse['response']['content'],
): AcceptedModelResponse {
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 1,
  };
  return {
    response: { content, stop_reason: 'end_turn', usage },
    stopReason: 'end_turn',
    attempts: 1,
    usage,
  };
}

function transcript(): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('v3 session vertical acceptance', () => {
  it('writes then publishes in order, resumes one conversation, continues after prose, and finishes explicitly', async () => {
    const responses = [
      accepted([
        { type: 'text', text: 'I will build and publish the report.' },
        {
          type: 'tool_use',
          id: 'write-report',
          name: 'write_file',
          input: {
            file_path: 'scratch/workspace/report.csv',
            content: 'name,value\nalpha,1\n',
          },
        },
        {
          type: 'tool_use',
          id: 'publish-report',
          name: 'publish_artifact',
          input: {
            kind: 'file',
            artifact_path: 'artifacts/report.csv',
            roles: ['requested_output', 'evidence'],
            source_path: 'scratch/workspace/report.csv',
            source_url: 'https://example.test/source',
          },
        },
      ]),
      accepted([{ type: 'text', text: 'I am checking the final shape.' }]),
      accepted([
        {
          type: 'tool_use',
          id: 'finish-report',
          name: 'finish',
          input: {
            summary: 'Published the requested two-column CSV report.',
          },
        },
      ]),
    ];
    const requests: Array<readonly Message[]> = [];
    const generate = vi.fn(async (options: ModelGenerateOptions) => {
      requests.push(structuredClone(options.messages));
      const response = responses.shift();
      if (response === undefined) throw new Error('scripted model exhausted');
      return response;
    });
    const model: ModelDriver = { generate };
    const budget = createRunBudgetTracker({
      maxWorkerTurns: Infinity,
      maxToolCalls: Infinity,
      maxModelTokens: Infinity,
      maxWallTimeMs: Infinity,
      maxVerifierCorrections: Infinity,
    });
    const deps = {
      model,
      registry: createV3ToolRegistry({
        javascriptPolicy: 'allow',
        secretEnvDenylist: ['TEST_SECRET'],
      }),
      runDir,
    };
    const config = { budget, maxContextTokens: Infinity };
    const worker = createV3WorkerSession(
      'Publish artifacts/report.csv with exactly name,value columns.',
      deps,
      config,
      { guidance: ['Expected output: artifacts/report.csv'] },
    );

    await expect(runV3WorkerTurn(worker)).resolves.toEqual({ kind: 'working' });
    expect(readFileSync(join(runDir, 'artifacts/report.csv'), 'utf8')).toBe(
      'name,value\nalpha,1\n',
    );

    const restored = restoreV3WorkerSession(
      captureV3WorkerSessionSnapshot(worker),
      deps,
      config,
    );
    const outcome = await runV3WorkerSession(restored);

    expect(outcome).toMatchObject({
      kind: 'finish_requested',
      request: {
        turn: 3,
        call: { id: 'finish-report', name: 'finish' },
        input: {
          summary: 'Published the requested two-column CSV report.',
        },
      },
    });
    expect(restored.state.messages[0]).toEqual(worker.state.messages[0]);
    expect(
      requests[2]?.at(-1)?.content.some(
        (block) => block.type === 'text' && block.text === V3_NO_TOOL_CONTINUATION,
      ),
    ).toBe(true);

    const manifest = readManifest(runDir);
    expect(
      manifest.artifacts.find((entry) => entry.filename === 'artifacts/report.csv'),
    ).toMatchObject({
      roles: ['requested_output', 'evidence'],
      sourceUrl: 'https://example.test/source',
    });
    verifyManifestFiles(runDir);

    const events = transcript();
    expect(
      events
        .filter((event) => event.type === 'tool_call')
        .map((event) => (event.call as { id: string }).id),
    ).toEqual(['write-report', 'publish-report', 'finish-report']);
    expect(
      events
        .filter((event) => event.type === 'tool_result')
        .map((event) => (event.result as { toolCallId: string }).toolCallId),
    ).toEqual(['write-report', 'publish-report']);
    expect(events.some((event) => event.type === 'worker_continuation')).toBe(true);
    expect(events.some((event) => event.type === 'finish_requested')).toBe(true);
  });
});
