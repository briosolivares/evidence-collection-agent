import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputContract } from '../../../src/agent/initializer/outputContract.schema.js';
import {
  ModelGenerationFailedError,
  type AcceptedModelResponse,
  type ModelDriver,
} from '../../../src/model/modelDriver.js';
import { initManifest, writeArtifact } from '../../../src/run/artifacts.js';
import {
  captureRunBudgetSnapshot,
  createRunBudgetTracker,
  type RunBudgetConfig,
} from '../../../src/run/runBudget.js';
import {
  REPORT_VERIFICATION_TOOL,
  VERIFIER_API_TOOL_DEFS,
  VERIFIER_MAX_CONTEXT_TOKENS,
  createVerifierModelDriver,
  runVerifier,
} from '../../../src/agent/verifier/verifier.js';
import {
  verificationResultSchema,
  type SurfacedArtifact,
} from '../../../src/agent/verifier/verificationResult.schema.js';
import { verifierPrompt } from '../../../src/prompts/index.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-verifier-'));
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
  unresolved: [],
};

const SURFACED_ARTIFACTS: SurfacedArtifact[] = [
  {
    filename: 'artifacts/report.csv',
    sha256: 'a'.repeat(64),
    roles: ['requested_output'],
    capturedAt: '2026-08-17T00:00:00.000Z',
  },
];

function budget(overrides: Partial<RunBudgetConfig> = {}) {
  return createRunBudgetTracker({
    maxWorkerTurns: Infinity,
    maxToolCalls: Infinity,
    maxModelTokens: Infinity,
    maxWallTimeMs: Infinity,
    maxVerifierCorrections: 2,
    ...overrides,
  });
}

function accepted(status: 'verified' | 'needs_correction'): AcceptedModelResponse {
  const findings =
    status === 'verified'
      ? []
      : [
          {
            kind: 'research' as const,
            requirement: 'Support the requested report with source evidence.',
            problem: 'The report has no published source evidence.',
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
  responseUsage: AcceptedModelResponse['response']['usage'] = {
    input_tokens: 10,
    output_tokens: 4,
  },
): AcceptedModelResponse {
  const response = {
    content,
    stop_reason: 'tool_use' as const,
    usage: responseUsage,
  };
  return {
    response,
    stopReason: 'tool_use',
    attempts: 1,
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}

function scriptedModel(steps: readonly AcceptedModelResponse[]): ModelDriver {
  const remaining = [...steps];
  return {
    generate: vi.fn(async () => {
      const next = remaining.shift();
      if (next === undefined) throw new Error('verifier script exhausted');
      return next;
    }),
  };
}

function report(input: unknown, id = 'verdict'): AcceptedModelResponse {
  return acceptedContent([{ type: 'tool_use', id, name: 'report_verification', input }]);
}

function inspect(id = 'inspect'): AcceptedModelResponse {
  return acceptedContent([
    {
      type: 'tool_use',
      id,
      name: 'read_file',
      input: { file_path: 'artifacts/report.csv' },
    },
  ]);
}

function verifyWith(model: ModelDriver) {
  return runVerifier({
    taskText: 'Create report.csv.',
    runDir,
    contract: CONTRACT,
    finish: FINISH,
    surfacedArtifacts: SURFACED_ARTIFACTS,
    model,
    budget: budget(),
  });
}

describe('verifier binding', () => {
  it('pins a frozen read-only inspection and verdict prefix', () => {
    expect(VERIFIER_API_TOOL_DEFS.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep',
      'report_verification',
    ]);
    expect(Object.isFrozen(VERIFIER_API_TOOL_DEFS)).toBe(true);
    expect(verifierPrompt).toContain('fresh, read-only evidence judge');
    expect(verifierPrompt).toContain('Prose is not a verdict');
    expect(verifierPrompt).not.toContain('report.csv');
  });

  it('validates model-driver limits at construction', () => {
    expect(() => createVerifierModelDriver({ maxOutputTokens: 0 })).toThrow(/maxOutputTokens/);
  });

  it('pins the fail-closed verdict schema', () => {
    expect(REPORT_VERIFICATION_TOOL.name).toBe('report_verification');
    expect(
      verificationResultSchema.safeParse({
        status: 'verified',
        findings: [],
      }).success,
    ).toBe(true);
    expect(
      verificationResultSchema.safeParse({
        status: 'verified',
        findings: [{ area: 'output', code: 'contradiction', message: 'not empty' }],
      }).success,
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [],
      }).success,
    ).toBe(false);
    // The legacy free-form shape (nextAction, no kind) no longer parses.
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [
          {
            requirement: 'Publish report.csv.',
            problem: 'The report is missing.',
            nextAction: 'Publish the requested report.',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [
          {
            kind: 'research',
            requirement: 'Publish report.csv.',
            problem: 'The report is missing.',
          },
        ],
      }).success,
    ).toBe(true);
    // artifact_repair requires nonempty evidencePaths.
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [
          {
            kind: 'artifact_repair',
            requirement: 'Publish report.csv.',
            problem: 'The report is missing a row already proven by evidence.',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [
          {
            kind: 'artifact_repair',
            requirement: 'Publish report.csv.',
            problem: 'The report is missing a row already proven by evidence.',
            evidencePaths: ['artifacts/report.csv'],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      verificationResultSchema.safeParse({
        status: 'needs_correction',
        findings: [
          {
            kind: 'report_repair',
            requirement: 'Report the actual state truthfully.',
            problem: 'The summary claims completion despite a credible blocker.',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      verificationResultSchema.safeParse({
        status: 'incomplete',
        findings: [
          {
            requirement: 'Use the inaccessible source.',
            assessment: 'The source rejects the available authenticated session.',
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('runVerifier', () => {
  it.each(['verified', 'needs_correction'] as const)(
    'returns a typed %s verdict and charges aggregate usage',
    async (status) => {
      const tracker = budget();
      const model: ModelDriver = {
        generate: vi.fn(async () => accepted(status)),
      };

      await expect(
        runVerifier({
          taskText: 'Create report.csv.',
          runDir,
          contract: CONTRACT,
          finish: FINISH,
          surfacedArtifacts: SURFACED_ARTIFACTS,
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

  it('treats prose as no verdict and allows exactly one repair', async () => {
    const prose = acceptedContent([{ type: 'text', text: 'DONE' }]);
    await expect(verifyWith(scriptedModel([prose, prose]))).resolves.toEqual({
      status: 'invalid_verdict',
      reason: 'verifier ended without a valid report_verification call',
    });

    const repaired = scriptedModel([prose, report({ status: 'verified', findings: [] })]);
    await expect(verifyWith(repaired)).resolves.toEqual({
      status: 'verified',
      findings: [],
    });
    expect(JSON.stringify(vi.mocked(repaired.generate).mock.calls[1]![0].messages)).toContain(
      'Prose is never a verdict',
    );
  });

  it('repairs one malformed report, then fails closed on a second', async () => {
    const invalid = report({
      status: 'verified',
      findings: [{ area: 'output', code: 'contradiction', message: 'not empty' }],
    });
    const repaired = scriptedModel([
      invalid,
      report({
        status: 'needs_correction',
        findings: [
          {
            kind: 'research',
            requirement: 'Include every requested row.',
            problem: 'One row is absent.',
          },
        ],
      }),
    ]);
    await expect(verifyWith(repaired)).resolves.toMatchObject({
      status: 'needs_correction',
    });
    expect(JSON.stringify(vi.mocked(repaired.generate).mock.calls[1]![0].messages)).toContain(
      'failed validation',
    );

    await expect(verifyWith(scriptedModel([invalid, invalid]))).resolves.toMatchObject({
      status: 'invalid_verdict',
      reason: expect.stringContaining('invalid report_verification input'),
    });
  });

  it('rejects an artifact_repair citing a non-surfaced path, then fails closed on a repeat', async () => {
    const citesUnsurfacedPath = report({
      status: 'needs_correction',
      findings: [
        {
          kind: 'artifact_repair',
          requirement: 'Include every requested row.',
          problem: 'One row is absent even though evidence already proves it.',
          evidencePaths: ['artifacts/not-surfaced.png'],
        },
      ],
    });
    await expect(
      verifyWith(scriptedModel([citesUnsurfacedPath, citesUnsurfacedPath])),
    ).resolves.toEqual({
      status: 'invalid_verdict',
      reason: expect.stringContaining(
        'artifact_repair evidencePaths must name only already-surfaced files',
      ),
    });
  });

  it('refuses verification while objective structural findings remain', async () => {
    const model = scriptedModel([
      report({ status: 'verified', findings: [] }),
      accepted('needs_correction'),
    ]);
    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        structuralFindings: [
          {
            code: 'missing_requested_output',
            message: 'artifacts/report.csv is missing.',
            outputId: 'report',
          },
        ],
        model,
        budget: budget(),
      }),
    ).resolves.toMatchObject({ status: 'needs_correction' });
    expect(JSON.stringify(vi.mocked(model.generate).mock.calls[1]![0].messages)).toContain(
      'objective structural findings remain',
    );
  });

  it('teaches the incomplete exit when verified contradicts unresolved requirements', async () => {
    const model = scriptedModel([
      report({ status: 'verified', findings: [] }),
      report({
        status: 'incomplete',
        findings: [
          {
            requirement: 'Include majors for every member.',
            assessment: 'The source lists names only; the blocker is credible.',
          },
        ],
      }),
    ]);
    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: {
          summary: 'Partial: majors are unavailable for two chapters.',
          unresolved: [
            {
              requirement: 'Include majors for every member.',
              reason: 'The official roster lists names only.',
              attempts: ['official roster', 'chapter site', 'targeted search'],
            },
          ],
        },
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: budget(),
      }),
    ).resolves.toMatchObject({ status: 'incomplete' });
    const repairMessages = JSON.stringify(vi.mocked(model.generate).mock.calls[1]![0].messages);
    expect(repairMessages).toContain('return incomplete with one finding per blocked requirement');
    expect(repairMessages).toContain('needs_correction with a typed finding');
  });

  it.each([
    {
      name: 'a report mixed with inspection',
      calls: [
        {
          type: 'tool_use' as const,
          id: 'verdict',
          name: 'report_verification',
          input: { status: 'verified', findings: [] },
        },
        {
          type: 'tool_use' as const,
          id: 'inspect',
          name: 'read_file',
          input: { file_path: 'artifacts/report.csv' },
        },
      ],
      reason: 'only tool call',
    },
    {
      name: 'multiple reports',
      calls: [
        {
          type: 'tool_use' as const,
          id: 'one',
          name: 'report_verification',
          input: { status: 'verified', findings: [] },
        },
        {
          type: 'tool_use' as const,
          id: 'two',
          name: 'report_verification',
          input: { status: 'verified', findings: [] },
        },
      ],
      reason: 'more than one',
    },
  ])('rejects $name after one repair', async ({ calls, reason }) => {
    const invalid = acceptedContent(calls);
    await expect(verifyWith(scriptedModel([invalid, invalid]))).resolves.toMatchObject({
      status: 'invalid_verdict',
      reason: expect.stringContaining(reason),
    });
  });

  it('forces a final report after the context ceiling and refuses more inspection', async () => {
    const overCeiling = acceptedContent(
      [
        {
          type: 'tool_use',
          id: 'inspect',
          name: 'read_file',
          input: { file_path: 'artifacts/report.csv' },
        },
      ],
      {
        input_tokens: VERIFIER_MAX_CONTEXT_TOKENS + 1,
        output_tokens: 1,
      },
    );
    const corrected = scriptedModel([
      overCeiling,
      report({
        status: 'needs_correction',
        findings: [
          {
            kind: 'research',
            requirement: 'Support every requested row.',
            problem: 'The evidence could not be fully inspected.',
          },
        ],
      }),
    ]);
    await expect(verifyWith(corrected)).resolves.toMatchObject({
      status: 'needs_correction',
    });
    expect(JSON.stringify(vi.mocked(corrected.generate).mock.calls[1]![0].messages)).toContain(
      'inspection budget is exhausted',
    );

    await expect(
      verifyWith(scriptedModel([overCeiling, inspect('inspect-again')])),
    ).resolves.toMatchObject({
      status: 'invalid_verdict',
      reason: expect.stringContaining('kept requesting tools'),
    });
  });

  it('stops before accepting a verdict that exceeds the whole-run tool-call budget', async () => {
    const tracker = budget({ maxToolCalls: 0 });
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: tracker,
      }),
    ).rejects.toMatchObject({
      name: 'RoleBudgetExceededError',
      limit: 'tool_calls',
    });
    expect(captureRunBudgetSnapshot(tracker).toolCalls).toBe(1);
  });

  it('charges verifier inspection calls and records model-visible result bytes', async () => {
    writeArtifact(runDir, 'artifacts/report.csv', Buffer.from('name\nAlice\n', 'utf8'), {
      roles: ['requested_output'],
    });
    const tracker = budget();
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
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: tracker,
      }),
    ).resolves.toMatchObject({
      status: 'verified',
    });
    const snapshot = captureRunBudgetSnapshot(tracker);
    expect(snapshot.toolCalls).toBe(2);
    expect(snapshot.toolResultBytes).toBeGreaterThan(1);
    expect(model.generate).toHaveBeenCalledTimes(2);
  });

  it('propagates a durable-accounting failure instead of downgrading it to verifier unavailable', async () => {
    const persistenceFailure = new Error('checkpoint fsync failed');
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: budget(),
        afterAccounting: async () => {
          throw persistenceFailure;
        },
      }),
    ).rejects.toMatchObject({
      name: 'VerifierAccountingPersistenceError',
      cause: persistenceFailure,
    });
  });

  it('fails closed on a fatal model call while retaining known billing', async () => {
    const tracker = budget();
    const failure = new ModelGenerationFailedError(new Error('transport failed'), {
      input_tokens: 7,
      output_tokens: 2,
    });
    const model: ModelDriver = {
      generate: vi.fn(async () => {
        throw failure;
      }),
    };

    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
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
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('labels the finish summary as a worker claim rather than a settled fact', async () => {
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await runVerifier({
      taskText: 'Create report.csv.',
      runDir,
      contract: CONTRACT,
      finish: FINISH,
      surfacedArtifacts: SURFACED_ARTIFACTS,
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

    const opening = JSON.stringify(vi.mocked(model.generate).mock.calls[0]![0].messages);
    expect(opening).toContain('Worker completion report (untrusted claim)');
    expect(opening).toContain('Surfaced manifest entries');
    expect(opening).toContain('artifacts/report.csv');
    expect(opening).toContain(FINISH.summary);
    expect(opening).not.toContain('Which period should the report cover?');
    expect(opening).toContain('Already established by code');
    expect(opening.indexOf(FINISH.summary)).toBeLessThan(
      opening.indexOf('Already established by code'),
    );
  });

  it('renders per-column nonblank coverage as informational, and omits it when absent', async () => {
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await runVerifier({
      taskText: 'Create report.csv.',
      runDir,
      contract: CONTRACT,
      finish: FINISH,
      surfacedArtifacts: SURFACED_ARTIFACTS,
      model,
      budget: budget(),
      outputs: [
        {
          kind: 'table',
          outputId: 'report',
          artifactPath: 'artifacts/report.csv',
          format: 'csv',
          columns: ['name'],
          rowCount: 5,
          columnNonblankCounts: [{ column: 'name', nonblankCount: 2 }],
          satisfiedRules: [],
        },
      ],
    });
    const opening = JSON.stringify(vi.mocked(model.generate).mock.calls[0]![0].messages);
    expect(opening).toContain('Per-column nonblank coverage');
    expect(opening).toContain('informational');
    expect(opening).toContain('name: 2 nonblank');

    // Outputs loaded from an old checkpoint omit the field entirely; the
    // section must not render at all rather than render an empty one.
    const withoutCounts: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };
    await runVerifier({
      taskText: 'Create report.csv.',
      runDir,
      contract: CONTRACT,
      finish: FINISH,
      surfacedArtifacts: SURFACED_ARTIFACTS,
      model: withoutCounts,
      budget: budget(),
      outputs: [
        {
          kind: 'table',
          outputId: 'report',
          artifactPath: 'artifacts/report.csv',
          format: 'csv',
          columns: ['name'],
          rowCount: 5,
          satisfiedRules: [],
        },
      ],
    });
    const openingWithoutCounts = JSON.stringify(
      vi.mocked(withoutCounts.generate).mock.calls[0]![0].messages,
    );
    expect(openingWithoutCounts).not.toContain('Per-column nonblank coverage');
  });

  it('builds its opening without walking an unmanifested symlink cycle', async () => {
    const trapDir = join(runDir, 'artifacts', 'unmanifested-tree');
    mkdirSync(trapDir, { recursive: true });
    symlinkSync('.', join(trapDir, 'cycle'), 'dir');
    const model: ModelDriver = {
      generate: vi.fn(async () => accepted('verified')),
    };

    await expect(
      runVerifier({
        taskText: 'Create report.csv.',
        runDir,
        contract: CONTRACT,
        finish: FINISH,
        surfacedArtifacts: SURFACED_ARTIFACTS,
        model,
        budget: budget(),
      }),
    ).resolves.toMatchObject({ status: 'verified' });

    const opening = JSON.stringify(vi.mocked(model.generate).mock.calls[0]![0].messages);
    expect(opening).not.toContain('unmanifested-tree');
    expect(opening).not.toContain('unmanifested-tree');
  });
});
