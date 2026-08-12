import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolProfile } from '../../src/tools/index.js';
import { analyzeBrowserBatchExperiment, formatBrowserBatchAnalysis } from './browserBatch.js';

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'browser-batch-analysis-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeCondition(profile: ToolProfile, name: string, events: unknown[]): string {
  const runDir = join(fixtureDir, `${profile}-${name}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'metrics.json'),
    JSON.stringify({
      status: 'completed',
      turns: 4,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
      peakContextTokens: 80,
      wallClockMs: 1_000,
    }),
  );
  writeFileSync(
    join(runDir, 'transcript.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const reportPath = join(fixtureDir, `${profile}-${name}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({
      startedAt: '2026-08-11T00:00:00.000Z',
      finishedAt: '2026-08-11T00:01:00.000Z',
      k: 1,
      model: 'test-model',
      toolProfile: profile,
      tasks: [
        {
          task: name,
          k: 1,
          accuracy: 1,
          taskPassed: true,
          meanLatencyMs: 1_100,
          trials: [
            {
              runDir,
              assertions: [{ name: 'ok', passed: true, detail: 'ok' }],
              latencyMs: 1_100,
              completed: true,
            },
          ],
        },
      ],
    }),
  );
  return reportPath;
}

const firstResponse = {
  type: 'model_response',
  turn: 1,
  response: {
    usage: {
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 10,
    },
  },
};

describe('browser batch experiment analyzer', () => {
  it('counts direct calls, successful/failed batches, adoption, and compression', () => {
    const atomic = writeCondition('atomic', 'task', [
      firstResponse,
      { type: 'tool_call', call: { id: 'a1', name: 'navigate', input: { url: 'x' } } },
      { type: 'tool_call', call: { id: 'a2', name: 'inspect_page', input: {} } },
    ]);
    const batch = writeCondition('batch-enabled', 'task', [
      firstResponse,
      {
        type: 'tool_call',
        call: {
          id: 'b1',
          name: 'browser_batch',
          input: {
            actions: [
              { tool: 'click', input: { ref: 'e1' } },
              { tool: 'inspect_page', input: {} },
            ],
          },
        },
      },
      {
        type: 'tool_result',
        result: {
          toolCallId: 'b1',
          isError: false,
          content: JSON.stringify({ status: 'completed', results: [] }),
        },
      },
      {
        type: 'tool_call',
        call: {
          id: 'b2',
          name: 'browser_batch',
          input: { actions: [{ tool: 'scroll', input: { direction: 'down' } }] },
        },
      },
      {
        type: 'tool_result',
        result: { toolCallId: 'b2', isError: true, content: 'stale ref' },
      },
      { type: 'tool_call', call: { id: 'b3', name: 'navigate', input: { url: 'x' } } },
    ]);

    const analysis = analyzeBrowserBatchExperiment({ atomic: [atomic], 'batch-enabled': [batch] });
    const treatment = analysis.conditions['batch-enabled'].overall;
    expect(treatment.adoptionTrials).toBe(1);
    expect(treatment.directAtomicBrowserCalls).toBe(1);
    expect(treatment.batchCalls).toBe(2);
    expect(treatment.batchErrors).toBe(1);
    expect(treatment.nestedBrowserOperations).toBe(3);
    expect(treatment.browserOperations).toBe(4);
    expect(treatment.modelVisibleBrowserCalls).toBe(3);
    expect(treatment.batchedOperationShare).toBe(0.75);
    expect(treatment.operationsPerModelVisibleCall).toBeCloseTo(4 / 3);
    expect(treatment.approximateWeightedTokens.median).toBe(217.5);
    expect(formatBrowserBatchAnalysis(analysis)).toContain('batch errors 1/2');
  });

  it('follows offloaded batch results safely and tolerates legacy optional metrics', () => {
    const atomic = writeCondition('atomic', 'legacy', [firstResponse]);
    const batchRunDir = join(fixtureDir, 'batch-enabled-offload');
    const offloadDir = join(batchRunDir, 'tool-output');
    mkdirSync(offloadDir, { recursive: true });
    writeFileSync(
      join(offloadDir, 'browser_batch-1.txt'),
      JSON.stringify({ status: 'completed', results: [] }),
    );
    const batch = writeCondition('batch-enabled', 'offload', [
      firstResponse,
      {
        type: 'tool_call',
        call: {
          id: 'b1',
          name: 'browser_batch',
          input: { actions: [{ tool: 'inspect_page', input: {} }] },
        },
      },
      {
        type: 'tool_result',
        result: {
          toolCallId: 'b1',
          content: JSON.stringify({ offloadedTo: 'tool-output/browser_batch-1.txt' }),
        },
      },
    ]);
    // Replace the full metrics shape with an older minimal shape.
    writeFileSync(
      join(batchRunDir, 'metrics.json'),
      JSON.stringify({ status: 'completed', turns: 2, inputTokens: 10, outputTokens: 2 }),
    );

    const analysis = analyzeBrowserBatchExperiment({ atomic: [atomic], 'batch-enabled': [batch] });
    const trial = analysis.conditions['batch-enabled'].trials[0]!;
    expect(trial.cacheReadInputTokens).toBe(0);
    expect(trial.peakContextTokens).toBeNull();
    expect(trial.batchCalls).toBe(1);
  });

  it('aggregates three k=1 blocks and rejects mislabeled result files', () => {
    const atomic = [1, 2, 3].map((index) => writeCondition('atomic', `a${index}`, [firstResponse]));
    const batch = [1, 2, 3].map((index) =>
      writeCondition('batch-enabled', `b${index}`, [firstResponse]),
    );
    const analysis = analyzeBrowserBatchExperiment({ atomic, 'batch-enabled': batch });
    expect(analysis.conditions.atomic.overall.trials).toBe(3);
    expect(analysis.conditions['batch-enabled'].overall.trials).toBe(3);
    expect(() =>
      analyzeBrowserBatchExperiment({ atomic: [batch[0]!], 'batch-enabled': batch }),
    ).toThrow(/expected atomic/);
  });
});
