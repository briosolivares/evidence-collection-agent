import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputContract } from '../../contracts/outputContract.js';
import {
  ModelGenerationFailedError,
  type AcceptedModelResponse,
  type ModelDriver,
} from '../../model/modelDriver.js';
import { initManifest, writeArtifact } from '../../run/artifacts.js';
import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  type RunBudgetConfig,
} from '../../run/runBudget.js';
import {
  V3_VERIFIER_API_TOOL_DEFS,
  V3_VERIFIER_SYSTEM_PROMPT,
  collectV3UserClarifications,
  createV3VerifierModelDriver,
  runV3Verifier,
} from './verifier.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-verifier-'));
  initManifest(runDir, 'Create report.csv.');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [],
    },
  ],
};

const FINISH = {
  summary: 'Published the requested report.',
  artifactPaths: ['artifacts/report.csv'],
  limitations: ['The source exposed only the current reporting period.'],
};

function budget(overrides: Partial<RunBudgetConfig> = {}) {
  return createRunBudgetTracker({
    maxWorkerTurns: Infinity,
    maxToolCalls: Infinity,
    maxModelTokens: Infinity,
    maxToolResultBytes: Infinity,
    maxWallTimeMs: Infinity,
    maxVerifierCorrections: 2,
    ...overrides,
  });
}

function accepted(
  status: 'verified' | 'needs_correction',
): AcceptedModelResponse {
  const findings =
    status === 'verified'
      ? []
      : [
          {
            area: 'evidence',
            code: 'missing_source',
            message: 'The report has no published source evidence.',
            outputId: 'report',
          },
        ];
  return acceptedContent([
      {
        type: 'tool_use' as const,
        id: 'verdict',
        name: 'report_verification',
        input: { status, findings },
      },
    ]);
}

function acceptedContent(
  content: AcceptedModelResponse['response']['content'],
): AcceptedModelResponse {
  const response = {
    content,
    stop_reason: 'tool_use' as const,
    usage: { input_tokens: 10, output_tokens: 4 },
  };
  return {
    response,
    stopReason: 'tool_use',
    attempts: 1,
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}

describe('v3 verifier binding', () => {
  it('pins a frozen read-only inspection and verdict prefix', () => {
    expect(V3_VERIFIER_API_TOOL_DEFS.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep',
      'report_verification',
    ]);
    expect(Object.isFrozen(V3_VERIFIER_API_TOOL_DEFS)).toBe(true);
    expect(V3_VERIFIER_SYSTEM_PROMPT).toContain('fresh-context verifier');
    expect(V3_VERIFIER_SYSTEM_PROMPT).toContain('Prose is not a verdict');
    expect(V3_VERIFIER_SYSTEM_PROMPT).not.toContain('report.csv');
  });

  it('validates model-driver limits at construction', () => {
    expect(() => createV3VerifierModelDriver({ maxOutputTokens: 0 })).toThrow(
      /maxOutputTokens/,
    );
  });
});

describe('runV3Verifier', () => {
  it('extracts successful ask_user answers without treating denied calls as clarification', () => {
    expect(
      collectV3UserClarifications([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'allowed',
              name: 'ask_user',
              input: {
                question: 'Which period?',
                context: 'Two periods are available.',
              },
            },
            {
              type: 'tool_use',
              id: 'denied',
              name: 'ask_user',
              input: { question: 'May I continue?' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'allowed',
              content: 'User answered: "Current period"',
            },
            {
              type: 'tool_result',
              tool_use_id: 'denied',
              content: 'The user declined.',
              is_error: true,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        question: 'Which period?',
        context: 'Two periods are available.',
        answer: 'User answered: "Current period"',
      },
    ]);
  });

  it.each(['verified', 'needs_correction'] as const)(
    'returns a typed %s verdict and charges aggregate usage',
    async (status) => {
      const tracker = budget();
      const model: ModelDriver = {
        generate: vi.fn(async () => accepted(status)),
      };

      await expect(
        runV3Verifier({
          taskText: 'Create report.csv.',
          runDir,
          contract: CONTRACT,
          finish: FINISH,
          clarifications: [],
          model,
          budget: tracker,
        }),
      ).resolves.toMatchObject({ status });
      expect(tracker.roleUsage().verifier).toMatchObject({
        turns: 1,
        inputTokens: 20,
        outputTokens: 8,
      });
      expect(captureRunBudgetSnapshot(tracker).toolCalls).toBe(1);
    },
  );

  it('stops before accepting a verdict that exceeds the whole-run tool-call budget', async () => {
    const tracker = budget({ maxToolCalls: 0 });
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: tracker,
      }),
    ).rejects.toMatchObject({
      name: 'V3RoleBudgetExceededError',
      limit: 'tool_calls',
    });
    expect(captureRunBudgetSnapshot(tracker).toolCalls).toBe(1);
  });

  it('charges verifier inspection calls and model-visible result bytes', async () => {
    writeArtifact(
      runDir,
      'artifacts/report.csv',
      Buffer.from('name\nAlice\n', 'utf8'),
      { roles: ['requested_output'] },
    );
    const tracker = budget({ maxToolResultBytes: 1 });
    const steps = [
      acceptedContent([
        {
          type: 'tool_use' as const,
          id: 'inspect-report',
          name: 'read_file',
          input: { file_path: 'artifacts/report.csv' },
        },
      ]),
      accepted('verified'),
    ];
    const model: ModelDriver = {
      generate: vi.fn(async () => {
        const next = steps.shift();
        if (next === undefined) throw new Error('verifier script exhausted');
        return next;
      }),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: tracker,
      }),
    ).rejects.toMatchObject({
      name: 'V3RoleBudgetExceededError',
      limit: 'tool_result_bytes',
    });
    const snapshot = captureRunBudgetSnapshot(tracker);
    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.toolResultBytes).toBeGreaterThan(1);
    expect(model.generate).toHaveBeenCalledOnce();
  });

  it('propagates a durable-accounting failure instead of downgrading it to verifier unavailable', async () => {
    const persistenceFailure = new Error('checkpoint fsync failed');
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: budget(),
        afterAccounting: async () => {
          throw persistenceFailure;
        },
      }),
    ).rejects.toMatchObject({
      name: 'V3VerifierAccountingPersistenceError',
      cause: persistenceFailure,
    });
  });

  it('fails closed on a fatal model call while retaining known billing', async () => {
    const tracker = budget();
    const failure = new ModelGenerationFailedError(
      new Error('transport failed'),
      { input_tokens: 7, output_tokens: 2 },
    );
    const model: ModelDriver = {
      generate: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: tracker,
      }),
    ).resolves.toMatchObject({
      status: 'verifier_unavailable',
      reason: expect.stringContaining('transport failed'),
    });
    expect(tracker.roleUsage().verifier).toMatchObject({ inputTokens: 7 });
  });

  it('propagates cancellation instead of converting it to a verdict', async () => {
    const model: ModelDriver = {
      generate: vi.fn(async () => {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('labels finish limitations as worker claims rather than settled facts', async () => {
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await runV3Verifier({
      taskText: 'Create report.csv.',
      runDir,
      contract: CONTRACT,
      finish: FINISH,
      clarifications: [
        {
          question: 'Which period should the report cover?',
          answer: 'Use only the current reporting period.',
        },
      ],
      model,
      budget: budget(),
      settled: [
        {
          code: 'table_shape',
          outputId: 'report',
          statement: 'The table has the exact declared columns.',
        },
      ],
    });

    const opening = JSON.stringify(
      vi.mocked(model.generate).mock.calls[0]![0].messages,
    );
    expect(opening).toContain('Run-specific completion claim (not code-settled)');
    expect(opening).toContain(FINISH.limitations[0]);
    expect(opening).toContain('Which period should the report cover?');
    expect(opening).toContain('Use only the current reporting period.');
    expect(opening).toContain('Already established by code');
    expect(opening.indexOf(FINISH.limitations[0])).toBeLessThan(
      opening.indexOf('Already established by code'),
    );
  });

  it('builds its opening without walking an unmanifested symlink cycle', async () => {
    const trapDir = join(runDir, 'artifacts', 'unmanifested-tree');
    mkdirSync(trapDir, { recursive: true });
    symlinkSync('.', join(trapDir, 'cycle'), 'dir');
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runV3Verifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        clarifications: [],
        model,
        budget: budget(),
      }),
    ).resolves.toMatchObject({ status: 'verified' });

    const opening = JSON.stringify(
      vi.mocked(model.generate).mock.calls[0]![0].messages,
    );
    expect(opening).not.toContain('unmanifested-tree');
    expect(opening).toContain('manifest.json');
  });
});
