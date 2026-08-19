import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract } from './initializer/outputContract.js';
import type { FinishFacts, TableFact } from './completion/finishChecks.js';
import {
  CHECKPOINT_MAX_BYTES,
  HARNESS_DIR,
  RUN_CHECKPOINT_FILENAME,
  RUN_LOCK_FILENAME,
  RUN_LOCK_RECOVERY_FILENAME,
  readCheckpointConfiguration,
  readCheckpointResumeInfo,
  ceilingFromCheckpoint,
  ceilingToCheckpoint,
  openCheckpointStore,
  checkpointSchema,
  durableTerminalOutcomeSchema,
  initializerProgressSchema,
  pendingToolTurnSchema,
  type Checkpoint,
  type DurableRunConfiguration,
} from './checkpoint.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'checkpoint-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const configuration: DurableRunConfiguration = {
  taskText: 'Publish a one-column roster CSV.',
  model: 'claude-sonnet-5',
  maxOutputTokens: 8_192,
  maxContextTokens: 180_000,
  browserProvider: 'local',
  authenticated: false,
  javascriptPolicy: 'allow',
  maxInitializerAttempts: 2,
  maxCompletionCheckFailures: 3,
  budgetLimits: {
    maxWorkerTurns: 24,
    maxToolCalls: 100,
    maxModelTokens: 250_000,
    // Retained here to exercise read compatibility with checkpoints written
    // before the cumulative tool-result ceiling was retired.
    maxToolResultBytes: 5_000_000,
    maxWallTimeMs: 3_600_000,
    maxVerifierCorrections: 3,
  },
};

const contract: OutputContract = {
  outputs: [
    {
      id: 'roster',
      kind: 'table',
      filename: 'roster.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [],
    },
  ],
};

const budget = {
  elapsedWallTimeMs: 123,
  roles: {
    initializer: {
      turns: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 5,
      wallClockMs: 50,
    },
  },
  toolCalls: 0,
  toolResultBytes: 0,
  corrections: 0,
};

const progress = { verifierCycles: 0, completionCheckFailures: 0 };

const worker = {
  messages: [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: configuration.taskText }],
    },
  ],
  turnCount: 0,
  peakContextTokens: 0,
  protocolCorrections: 0,
  startedMs: 100,
};

const finish = {
  turn: 2,
  call: {
    id: 'finish-1',
    name: 'finish' as const,
    input: {
      summary: 'Published the requested roster.',
      unresolved: [],
    },
  },
  input: {
    summary: 'Published the requested roster.',
    unresolved: [],
  },
  assistantText: 'The roster is ready.',
};

const finishWorker = {
  ...worker,
  messages: [
    ...worker.messages,
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: finish.assistantText },
        {
          type: 'tool_use' as const,
          id: finish.call.id,
          name: finish.call.name,
          input: finish.call.input,
        },
      ],
    },
  ],
  turnCount: finish.turn,
};

function legacyFinishInput(artifacts = ['artifacts/roster.csv']) {
  return {
    summary: finish.input.summary,
    artifacts,
    limitations: ['Historical source-access constraint.'],
  };
}

function legacyFinishWorker(artifacts = ['artifacts/roster.csv']) {
  const input = legacyFinishInput(artifacts);
  return {
    ...finishWorker,
    messages: [
      ...worker.messages,
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: finish.assistantText },
          {
            type: 'tool_use' as const,
            id: finish.call.id,
            name: finish.call.name,
            input,
          },
        ],
      },
    ],
  };
}

const toolAssistant = {
  role: 'assistant' as const,
  content: [
    {
      type: 'tool_use' as const,
      id: 'write-1',
      name: 'write_file',
      input: { path: 'scratch/notes.txt', content: 'done' },
    },
  ],
};

const pendingToolTurn = {
  turn: 1,
  assistant: toolAssistant,
  calls: [
    {
      id: 'write-1',
      name: 'write_file',
      input: { path: 'scratch/notes.txt', content: 'done' },
    },
  ],
  completedResults: [],
  nextCallIndex: 0,
  effect: 'uncertain' as const,
};

const facts: FinishFacts = {
  finish: {
    summary: finish.input.summary,
    unresolved: [],
  },
  manifest: {
    task: configuration.taskText,
    browserProvider: 'local',
    entryCount: 1,
    verifiedPaths: ['artifacts/roster.csv'],
    requestedOutputPaths: ['artifacts/roster.csv'],
    evidencePaths: [],
  },
  outputs: [
    {
      kind: 'table',
      outputId: 'roster',
      artifactPath: 'artifacts/roster.csv',
      format: 'csv',
      columns: ['name'],
      rowCount: 1,
      satisfiedRules: [],
    },
  ],
  evidenceScreenshotPaths: [],
};

function typedVerificationHistory() {
  return [
    {
      cycle: 1,
      completionReport: finish.input,
      surfacedEvidenceFingerprint: 'a'.repeat(64),
      findings: [
        {
          kind: 'research' as const,
          requirement: 'Include every requested row.',
          problem: 'One row is absent.',
        },
      ],
    },
  ];
}

/** Durable correction-finding shape from before typed finding kinds existed:
 * a free-form nextAction plus an optional outputId. */
function legacyVerificationHistory() {
  return [
    {
      cycle: 1,
      completionReport: finish.input,
      surfacedEvidenceFingerprint: 'a'.repeat(64),
      findings: [
        {
          requirement: 'Include every requested row.',
          problem: 'One row is absent.',
          nextAction: 'Publish the missing row and republish the report.',
          outputId: 'roster',
        },
      ],
    },
  ];
}

function common(revision = 1) {
  return {
    version: 3 as const,
    revision,
    updatedAt: new Date(revision * 1_000).toISOString(),
    configuration,
    budget,
    progress,
  };
}

function initializing(revision = 1): Checkpoint {
  return { ...common(revision), phase: 'initializing' };
}

function ready(revision = 1): Checkpoint {
  return { ...common(revision), phase: 'ready_for_model', contract, worker };
}

function executing(revision = 1): Checkpoint {
  return {
    ...common(revision),
    phase: 'executing_tool',
    contract,
    worker: {
      ...worker,
      messages: [...worker.messages, toolAssistant],
      turnCount: pendingToolTurn.turn,
    },
    pendingTurn: pendingToolTurn,
  };
}

function checking(revision = 1): Checkpoint {
  return {
    ...common(revision),
    phase: 'checking',
    contract,
    worker: finishWorker,
    pendingFinish: finish,
    pendingCheck: { status: 'pending', attempt: 1 },
  };
}

function verifying(revision = 1): Checkpoint {
  return {
    ...common(revision),
    phase: 'verifying',
    contract,
    worker: finishWorker,
    pendingFinish: finish,
    pendingCheck: { status: 'passed', attempt: 1, facts },
    pendingVerifier: {
      cycle: 1,
      recovery: 'restart_read_only',
    },
  };
}

function terminal(revision = 1): Checkpoint {
  return {
    ...common(revision),
    phase: 'terminal',
    contract,
    worker: finishWorker,
    finish: finish.input,
    outcome: { status: 'verified', finalText: finish.input.summary },
  };
}

function initializerTerminal(revision = 1): Checkpoint {
  return {
    ...common(revision),
    phase: 'terminal',
    outcome: {
      status: 'incomplete',
      during: 'initializing',
      reason: 'initializer_unavailable',
      detail: 'initializer unavailable',
      finalText: '',
      unresolved: [],
    },
  };
}

function pathInHarness(name: string): string {
  return join(runDir, HARNESS_DIR, name);
}

function checkpointForTransition(
  phase: Checkpoint['phase'],
  revision: number,
  priorPhase?: Checkpoint['phase'],
): Checkpoint {
  switch (phase) {
    case 'initializing':
      return initializing(revision);
    case 'ready_for_model':
      return ready(revision);
    case 'executing_tool':
      return executing(revision);
    case 'checking':
      return checking(revision);
    case 'verifying':
      return verifying(revision);
    case 'terminal':
      return priorPhase === 'initializing'
        ? initializerTerminal(revision)
        : terminal(revision);
  }
}

describe('checkpoint schema', () => {
  it('round-trips an unbounded ceiling without JSON coercion', () => {
    expect(ceilingToCheckpoint(Infinity)).toBe('unbounded');
    expect(ceilingFromCheckpoint('unbounded')).toBe(Infinity);
    expect(ceilingToCheckpoint(42)).toBe(42);
    expect(() => ceilingToCheckpoint(Number.NaN)).toThrow(/non-finite/);
  });

  it('round-trips the optional per-column nonblank count field, and still parses without it', () => {
    const tableFactWithCounts: TableFact = {
      ...(facts.outputs[0] as TableFact),
      columnNonblankCounts: [{ column: 'name', nonblankCount: 1 }],
    };
    const withCounts = {
      ...verifying(),
      pendingCheck: {
        status: 'passed' as const,
        attempt: 1,
        facts: { ...facts, outputs: [tableFactWithCounts] },
      },
    };
    expect(checkpointSchema.parse(withCounts)).toEqual(withCounts);

    // Checkpoints written before this field existed carry no
    // `columnNonblankCounts` at all; they must still parse unchanged.
    expect(checkpointSchema.parse(verifying())).toEqual(verifying());
  });

  it('round-trips new typed verification-history findings and normalizes legacy nextAction findings', () => {
    const withTypedHistory = {
      ...verifying(),
      verificationHistory: typedVerificationHistory(),
    };
    expect(checkpointSchema.parse(withTypedHistory)).toEqual(withTypedHistory);

    const withLegacyHistory = {
      ...verifying(),
      verificationHistory: legacyVerificationHistory(),
    };
    const parsedLegacy = checkpointSchema.parse(withLegacyHistory);
    if (parsedLegacy.phase !== 'verifying') {
      throw new Error('expected a verifying checkpoint');
    }
    // nextAction and outputId are intentionally dropped: an old free-form
    // instruction must never be executed after upgrade.
    expect(parsedLegacy.verificationHistory).toEqual([
      {
        cycle: 1,
        completionReport: finish.input,
        surfacedEvidenceFingerprint: 'a'.repeat(64),
        findings: [
          {
            kind: 'research',
            requirement: 'Include every requested row.',
            problem: 'One row is absent.',
          },
        ],
      },
    ]);
  });

  it('accepts every phase with only its required durable state', () => {
    const values: Checkpoint[] = [
      initializing(),
      { ...initializing(), contract },
      ready(),
      executing(),
      checking(),
      verifying(),
      {
        ...common(),
        phase: 'terminal',
        outcome: {
          status: 'incomplete',
          during: 'initializing',
          reason: 'initializer_unavailable',
          detail: 'The contract initializer exhausted its bounded attempts.',
          finalText: '',
          unresolved: [],
        },
      },
      {
        ...common(),
        phase: 'terminal',
        outcome: {
          status: 'incomplete',
          during: 'initializing',
          reason: 'budget_exceeded',
          detail: 'The initializer exhausted the run model-token budget.',
          finalText: '',
          unresolved: [],
        },
      },
    ];

    for (const value of values) {
      expect(checkpointSchema.safeParse(value).success).toBe(true);
    }
  });

  it('keeps strict phase boundaries and requires contract plus worker while active', () => {
    expect(
      checkpointSchema.safeParse({ ...initializing(), surprise: true }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({ ...ready(), contract: undefined }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({ ...ready(), worker: undefined }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({ ...ready(), pendingFinish: finish }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({ ...checking(), pendingCheck: undefined }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({ ...verifying(), pendingVerifier: undefined }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({
        ...verifying(),
        pendingVerifier: {
          cycle: 1,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'synthetic state' }] },
          ],
          attempts: 0,
        },
      }).success,
    ).toBe(false);
  });

  it('persists compatible bounded initializer progress only before contract acceptance', () => {
    const initializer = {
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: configuration.taskText }],
        },
      ],
      attempts: 1,
      lastProblem: 'The first response had no contract call.',
    };
    expect(initializerProgressSchema.safeParse(initializer).success).toBe(true);
    expect(
      checkpointSchema.safeParse({ ...initializing(), initializer }).success,
    ).toBe(true);
    expect(
      checkpointSchema.safeParse({ ...initializing(), initializer, contract }).success,
    ).toBe(false);
    expect(
      initializerProgressSchema.safeParse({ ...initializer, attempts: 3 }).success,
    ).toBe(false);
  });

  it('requires ordered completed tool results and exact assistant calls', () => {
    const base = {
      turn: 1,
      assistant: {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 'a', name: 'read_file', input: { path: 'scratch/a' } },
          { type: 'tool_use' as const, id: 'b', name: 'read_file', input: { path: 'scratch/b' } },
        ],
      },
      calls: [
        { id: 'a', name: 'read_file', input: { path: 'scratch/a' } },
        { id: 'b', name: 'read_file', input: { path: 'scratch/b' } },
      ],
      completedResults: [
        { type: 'tool_result' as const, tool_use_id: 'a', content: 'A' },
      ],
      nextCallIndex: 1,
      effect: 'not_started' as const,
    };
    expect(pendingToolTurnSchema.safeParse(base).success).toBe(true);
    expect(
      pendingToolTurnSchema.safeParse({
        ...base,
        completedResults: [{ ...base.completedResults[0], tool_use_id: 'b' }],
      }).success,
    ).toBe(false);
    expect(
      pendingToolTurnSchema.safeParse({ ...base, nextCallIndex: 2 }).success,
    ).toBe(false);
    expect(
      pendingToolTurnSchema.safeParse({
        ...base,
        calls: [...base.calls].reverse(),
      }).success,
    ).toBe(false);
    expect(
      pendingToolTurnSchema.safeParse({
        ...base,
        assistant: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'finish-1', name: 'finish', input: finish.input },
          ],
        },
        calls: [{ id: 'finish-1', name: 'finish', input: finish.input }],
        completedResults: [],
        nextCallIndex: 0,
      }).success,
    ).toBe(false);
  });

  it('cross-checks task and turn identity against the immutable snapshot', () => {
    expect(
      checkpointSchema.safeParse({
        ...ready(),
        worker: {
          ...worker,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'different task' }] },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({
        ...checking(),
        pendingFinish: { ...finish, turn: 99 },
      }).success,
    ).toBe(false);
  });

  it('links an executing pending turn to the exact trailing worker assistant response', () => {
    const assistant = {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'read-a',
          name: 'read_file',
          input: { path: 'scratch/a.txt' },
        },
        {
          type: 'tool_use' as const,
          id: 'read-b',
          name: 'read_file',
          input: { path: 'scratch/b.txt' },
        },
      ],
    };
    const pendingTurn = {
      turn: 1,
      assistant,
      calls: assistant.content.map(({ id, name, input }) => ({ id, name, input })),
      completedResults: [],
      nextCallIndex: 0,
      effect: 'not_started' as const,
    };
    const checkpoint = {
      ...common(),
      phase: 'executing_tool' as const,
      contract,
      worker: {
        ...worker,
        messages: [...worker.messages, assistant],
        turnCount: 1,
      },
      pendingTurn,
    };
    expect(checkpointSchema.safeParse(checkpoint).success).toBe(true);

    const wrongInput = structuredClone(assistant);
    wrongInput.content[0]!.input = { path: 'scratch/other.txt' };
    const wrongId = structuredClone(assistant);
    wrongId.content[0]!.id = 'different-id';
    const wrongOrder = {
      ...assistant,
      content: [...assistant.content].reverse(),
    };
    for (const trailing of [wrongInput, wrongId, wrongOrder]) {
      expect(
        checkpointSchema.safeParse({
          ...checkpoint,
          worker: {
            ...checkpoint.worker,
            messages: [...worker.messages, trailing],
          },
        }).success,
      ).toBe(false);
    }
    expect(
      checkpointSchema.safeParse({
        ...checkpoint,
        worker: { ...checkpoint.worker, messages: [...worker.messages] },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['checking', () => checking()],
    ['verifying', () => verifying()],
  ] as const)(
    'links %s pending finish state to one exact trailing finish call',
    (_phase, makeCheckpoint) => {
      const checkpoint = makeCheckpoint();
      expect(checkpointSchema.safeParse(checkpoint).success).toBe(true);

      expect(
        checkpointSchema.safeParse({
          ...checkpoint,
          pendingFinish: {
            ...finish,
            call: { ...finish.call, id: 'different-finish-id' },
          },
        }).success,
      ).toBe(false);

      const changedInput = {
        ...finish.input,
        summary: 'A different durable finish summary.',
      };
      expect(
        checkpointSchema.safeParse({
          ...checkpoint,
          pendingFinish: {
            ...finish,
            call: { ...finish.call, input: changedInput },
            input: changedInput,
          },
        }).success,
      ).toBe(false);

      expect(
        checkpointSchema.safeParse({
          ...checkpoint,
          worker: {
            ...finishWorker,
            messages: [
              ...worker.messages,
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'other-call',
                    name: 'read_file',
                    input: { path: 'scratch/a.txt' },
                  },
                  ...finishWorker.messages.at(-1)!.content,
                ],
              },
            ],
          },
        }).success,
      ).toBe(false);

      expect(
        checkpointSchema.safeParse({
          ...checkpoint,
          pendingFinish: { ...finish, assistantText: 'different assistant text' },
        }).success,
      ).toBe(false);
    },
  );

  it('validates all truthful durable terminal outcomes', () => {
    const outcomes = [
      { status: 'verified', finalText: 'done' },
      {
        status: 'incomplete',
        during: 'verifying',
        reason: 'budget_exceeded',
        detail: 'tool call budget',
        finalText: '',
      },
      { status: 'failed', during: 'verifying', message: 'verifier crashed' },
      { status: 'cancelled', during: 'executing_tool', reason: 'user cancelled' },
    ];
    for (const outcome of outcomes) {
      expect(durableTerminalOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    expect(
      durableTerminalOutcomeSchema.safeParse({ status: 'failed', message: 'x' }).success,
    ).toBe(false);
    expect(
      durableTerminalOutcomeSchema.safeParse({
        status: 'incomplete',
        reason: 'budget_exceeded',
        detail: 'model token budget',
        finalText: '',
      }).success,
    ).toBe(false);

    expect(
      checkpointSchema.safeParse({
        ...common(),
        phase: 'terminal',
        outcome: {
          status: 'incomplete',
          during: 'verifying',
          reason: 'budget_exceeded',
          detail: 'verifier model token budget',
          finalText: '',
        },
      }).success,
    ).toBe(false);

    expect(
      checkpointSchema.safeParse({
        ...common(),
        phase: 'terminal',
        outcome: { status: 'verified', finalText: 'done' },
      }).success,
    ).toBe(false);
    expect(
      checkpointSchema.safeParse({
        ...common(),
        phase: 'terminal',
        contract,
        worker: finishWorker,
        finish: finish.input,
        outcome: { status: 'verified', finalText: finish.input.summary },
      }).success,
    ).toBe(true);
    expect(
      checkpointSchema.safeParse({
        ...common(),
        phase: 'terminal',
        contract,
        worker: finishWorker,
        finish: finish.input,
        outcome: { status: 'verified', finalText: 'different summary' },
      }).success,
    ).toBe(false);

    expect(
      checkpointSchema.safeParse({
        ...common(),
        phase: 'terminal',
        contract,
        worker,
        finish: finish.input,
        outcome: { status: 'verified', finalText: finish.input.summary },
      }).success,
    ).toBe(false);

    expect(
      checkpointSchema.safeParse({
        ...terminal(),
        finish: {
          ...finish.input,
          summary: 'A different durable finish summary.',
        },
      }).success,
    ).toBe(false);

    expect(
      checkpointSchema.safeParse({
        ...ready(),
        phase: 'terminal',
        finish: finish.input,
        outcome: {
          status: 'incomplete',
          during: 'ready_for_model',
          reason: 'worker_incomplete',
          detail: 'worker stopped',
          finalText: '',
        },
      }).success,
    ).toBe(false);
  });
});

describe('read-only checkpoint observation', () => {
  function writeCheckpoint(value: unknown): string {
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    const path = pathInHarness(RUN_CHECKPOINT_FILENAME);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  it('returns a detached frozen configuration without touching lock or directory state', () => {
    const checkpointPath = writeCheckpoint(ready());
    const lockPath = pathInHarness(RUN_LOCK_FILENAME);
    writeFileSync(lockPath, 'leave this corrupt lock untouched', { mode: 0o600 });
    const namesBefore = readdirSync(join(runDir, HARNESS_DIR)).sort();
    const checkpointBefore = readFileSync(checkpointPath);
    const lockBefore = readFileSync(lockPath);

    const observed = readCheckpointConfiguration(runDir);
    const resumeInfo = readCheckpointResumeInfo(runDir);

    expect(observed).toEqual(configuration);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.budgetLimits)).toBe(true);
    expect(Reflect.set(observed, 'model', 'mutated')).toBe(false);
    expect(observed.model).toBe(configuration.model);
    expect(resumeInfo).toEqual({
      phase: 'ready_for_model',
      configuration,
    });
    expect(Object.isFrozen(resumeInfo)).toBe(true);
    expect(resumeInfo.configuration).not.toBe(observed);
    expect(readdirSync(join(runDir, HARNESS_DIR)).sort()).toEqual(namesBefore);
    expect(readFileSync(checkpointPath)).toEqual(checkpointBefore);
    expect(readFileSync(lockPath)).toEqual(lockBefore);
  });

  it('migrates a legacy active finish list without rewriting checkpoint bytes', async () => {
    const legacyInput = legacyFinishInput();
    const legacy = {
      ...checking(),
      worker: legacyFinishWorker(),
      pendingFinish: {
        ...finish,
        call: { ...finish.call, input: legacyInput },
        input: legacyInput,
      },
    };
    const checkpointPath = writeCheckpoint(legacy);
    const before = readFileSync(checkpointPath);

    const store = await openCheckpointStore(runDir);
    expect(store.load()).toEqual(checking());
    await store.close();
    expect(readFileSync(checkpointPath)).toEqual(before);
  });

  it('migrates legacy nextAction verification-history findings without rewriting checkpoint bytes', async () => {
    const legacy = {
      ...verifying(),
      verificationHistory: legacyVerificationHistory(),
    };
    const checkpointPath = writeCheckpoint(legacy);
    const before = readFileSync(checkpointPath);

    const store = await openCheckpointStore(runDir);
    expect(store.load()).toEqual({
      ...verifying(),
      verificationHistory: typedVerificationHistory(),
    });
    await store.close();
    expect(readFileSync(checkpointPath)).toEqual(before);
  });

  it('migrates a legacy verified terminal finish list', async () => {
    const legacy = {
      ...terminal(),
      worker: legacyFinishWorker(),
      finish: legacyFinishInput(),
    };
    writeCheckpoint(legacy);

    const store = await openCheckpointStore(runDir);
    expect(store.load()).toEqual(terminal());
    await store.close();
  });

  it('does not hide mismatched current finish claims while normalizing legacy paths', async () => {
    const legacy = {
      ...checking(),
      worker: legacyFinishWorker(),
      pendingFinish: {
        ...finish,
        call: { ...finish.call, input: legacyFinishInput() },
        input: {
          ...legacyFinishInput(),
          summary: 'A different durable finish summary.',
        },
      },
    };
    writeCheckpoint(legacy);

    await expect(openCheckpointStore(runDir)).rejects.toThrow(
      /schema validation|must equal the validated finish input/,
    );
    expect(existsSync(pathInHarness(RUN_LOCK_FILENAME))).toBe(false);
  });

  it('does not create a missing harness directory or checkpoint', () => {
    const harnessDir = join(runDir, HARNESS_DIR);
    expect(() => readCheckpointConfiguration(runDir)).toThrow(
      /harness directory does not exist/,
    );
    expect(existsSync(harnessDir)).toBe(false);

    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    expect(() => readCheckpointConfiguration(runDir)).toThrow(
      /checkpoint does not exist/,
    );
    expect(readdirSync(harnessDir)).toEqual([]);
  });

  it('rejects malformed JSON, the wrong version, and invalid durable configuration', () => {
    const checkpointPath = writeCheckpoint(ready());

    writeFileSync(checkpointPath, '{bad json', { mode: 0o600 });
    expect(() => readCheckpointConfiguration(runDir)).toThrow(/not valid JSON/);

    writeFileSync(checkpointPath, JSON.stringify({ ...ready(), version: 2 }), {
      mode: 0o600,
    });
    expect(() => readCheckpointConfiguration(runDir)).toThrow(/version/);

    writeFileSync(
      checkpointPath,
      JSON.stringify({
        ...ready(),
        configuration: { ...configuration, model: '   ' },
      }),
      { mode: 0o600 },
    );
    expect(() => readCheckpointConfiguration(runDir)).toThrow(
      /configuration\.model/,
    );
  });

  it('refuses an oversized checkpoint before parsing it', () => {
    const checkpointPath = writeCheckpoint(ready());
    truncateSync(checkpointPath, CHECKPOINT_MAX_BYTES + 1);

    expect(() => readCheckpointConfiguration(runDir)).toThrow(
      new RegExp(`${CHECKPOINT_MAX_BYTES}-byte read limit`),
    );
  });

  it('does not follow a checkpoint symlink', () => {
    const target = join(runDir, 'outside-checkpoint.json');
    const targetBytes = `${JSON.stringify(ready())}\n`;
    writeFileSync(target, targetBytes, { mode: 0o600 });
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    symlinkSync(target, pathInHarness(RUN_CHECKPOINT_FILENAME));

    expect(() => readCheckpointConfiguration(runDir)).toThrow(
      /symlinks are not followed/,
    );
    expect(readFileSync(target, 'utf8')).toBe(targetBytes);
  });
});

describe('openCheckpointStore', () => {
  it.each([
    ['initializing', 'initializing'],
    ['initializing', 'ready_for_model'],
    ['initializing', 'terminal'],
    ['ready_for_model', 'ready_for_model'],
    ['ready_for_model', 'executing_tool'],
    ['ready_for_model', 'checking'],
    ['ready_for_model', 'terminal'],
    ['executing_tool', 'executing_tool'],
    ['executing_tool', 'ready_for_model'],
    ['executing_tool', 'terminal'],
    ['checking', 'ready_for_model'],
    ['checking', 'verifying'],
    ['checking', 'terminal'],
    ['verifying', 'verifying'],
    ['verifying', 'ready_for_model'],
    ['verifying', 'terminal'],
  ] as const)('accepts the lawful %s -> %s phase transition', async (from, to) => {
    const store = await openCheckpointStore(runDir);
    await store.save(checkpointForTransition(from, 1));
    await store.save(checkpointForTransition(to, 2, from));
    expect(store.load()?.phase).toBe(to);
    await store.close();
  });

  it.each([
    ['terminal', 'ready_for_model'],
    ['terminal', 'terminal'],
    ['checking', 'initializing'],
    ['ready_for_model', 'initializing'],
    ['executing_tool', 'checking'],
    ['verifying', 'executing_tool'],
    ['initializing', 'checking'],
  ] as const)('rejects the illegal %s -> %s phase transition', async (from, to) => {
    const store = await openCheckpointStore(runDir);
    await store.save(checkpointForTransition(from, 1));
    await expect(
      store.save(checkpointForTransition(to, 2, from)),
    ).rejects.toThrow(new RegExp(`phase transition ${from} -> ${to}`));
    expect(store.load()?.phase).toBe(from);
    await store.close();
  });

  it('accepts a terminal checkpoint as an imported first snapshot but keeps it absorbing after reopen', async () => {
    const first = await openCheckpointStore(runDir);
    await first.save(terminal(7));
    await first.close();

    const reopened = await openCheckpointStore(runDir);
    await expect(reopened.save(ready(8))).rejects.toThrow(
      /phase transition terminal -> ready_for_model.*terminal is absorbing/i,
    );
    expect(reopened.load()?.revision).toBe(7);
    await reopened.close();
  });

  it('validates and defensively copies a save before it enters the queue', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = await openCheckpointStore(runDir, { beforeWrite: () => gate });

    await expect(
      store.save({ ...initializing(), unexpected: true } as unknown as Checkpoint),
    ).rejects.toThrow(/invalid checkpoint/);
    expect(store.load()).toBeUndefined();

    const candidate = {
      ...initializing(1),
      configuration: structuredClone(configuration),
    } as Checkpoint;
    const saving = store.save(candidate);
    candidate.configuration.model = 'mutated-after-save';
    release?.();
    await saving;
    expect(store.load()?.configuration.model).toBe(configuration.model);
    await store.close();
  });

  it('round-trips every typed payload and writes private durable files', async () => {
    const store = await openCheckpointStore(runDir);
    const checkpoint = verifying();
    await store.save(checkpoint);

    expect(store.load()).toEqual(checkpoint);
    expect(
      JSON.parse(readFileSync(pathInHarness(RUN_CHECKPOINT_FILENAME), 'utf8')),
    ).toEqual(checkpoint);
    expect(statSync(join(runDir, HARNESS_DIR)).mode & 0o777).toBe(0o700);
    expect(statSync(pathInHarness(RUN_LOCK_FILENAME)).mode & 0o777).toBe(0o600);
    expect(statSync(pathInHarness(RUN_CHECKPOINT_FILENAME)).mode & 0o777).toBe(0o600);

    await store.close();
  });

  it('enforces strictly increasing revisions across reopen', async () => {
    const first = await openCheckpointStore(runDir);
    await first.save(initializing(4));
    await expect(first.save(initializing(4))).rejects.toThrow(/strictly greater/);
    await first.close();

    const second = await openCheckpointStore(runDir);
    await expect(second.save(initializing(3))).rejects.toThrow(/strictly greater/);
    await second.save(initializing(5));
    expect(second.load()?.revision).toBe(5);
    await second.close();
  });

  it('locks configuration and accepted contract while allowing one acceptance transition', async () => {
    const store = await openCheckpointStore(runDir);
    await store.save(initializing(1));
    await store.save({ ...initializing(2), contract });
    await store.save(ready(3));

    await expect(
      store.save({
        ...ready(4),
        configuration: { ...configuration, model: 'a-different-model' },
      }),
    ).rejects.toThrow(/immutable.*configuration/i);
    await expect(
      store.save({
        ...ready(4),
        contract: {
          ...contract,
          outputs: [{ ...contract.outputs[0]!, filename: 'changed.csv' }],
        } as OutputContract,
      }),
    ).rejects.toThrow(/immutable.*contract/i);
    await expect(store.save(initializerTerminal(4))).rejects.toThrow(/remove.*contract/i);
    expect(store.load()?.revision).toBe(3);
    await store.close();
  });

  it('keeps the previous checkpoint after a failure at the pre-rename boundary', async () => {
    let fail = false;
    let stagedPath: string | undefined;
    const store = await openCheckpointStore(runDir, {
      afterTempFileSync: (path) => {
        stagedPath = path;
        if (fail) throw new Error('injected crash window');
      },
    });
    await store.save(initializing(1));
    fail = true;
    await expect(store.save(initializing(2))).rejects.toThrow(/injected crash window/);
    expect(store.load()?.revision).toBe(1);
    expect(stagedPath).toBeDefined();
    expect(existsSync(stagedPath!)).toBe(false);

    fail = false;
    await store.save(initializing(2));
    expect(store.load()?.revision).toBe(2);
    await store.close();
  });

  it('serializes queued saves and close waits before releasing the lock', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const store = await openCheckpointStore(runDir, {
      beforeWrite: async () => {
        writes += 1;
        order.push(`start-${writes}`);
        if (writes === 1) await gate;
        order.push(`end-${writes}`);
      },
    });

    const first = store.save(initializing(1));
    const second = store.save(initializing(2));
    const closing = store.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start-1']);
    await expect(openCheckpointStore(runDir)).rejects.toThrow(/already open/);

    release?.();
    await Promise.all([first, second, closing]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);

    await expect(store.save(initializing(3))).rejects.toThrow(/closed/);
    const reopened = await openCheckpointStore(runDir);
    await reopened.close();
  });

  it('recovers a stale lock but refuses a live or corrupt lock', async () => {
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    const lock = pathInHarness(RUN_LOCK_FILENAME);
    writeFileSync(
      lock,
      JSON.stringify({
        harnessInstanceId: 'dead',
        processId: 999_999,
        acquiredAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );
    const recovered = await openCheckpointStore(runDir);
    await recovered.close();

    writeFileSync(
      lock,
      JSON.stringify({
        harnessInstanceId: 'live',
        processId: process.pid,
        acquiredAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );
    await expect(openCheckpointStore(runDir)).rejects.toThrow(/already open/);
    rmSync(lock);
    writeFileSync(lock, 'not json', { mode: 0o600 });
    await expect(openCheckpointStore(runDir)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(lock, 'utf8')).toBe('not json');
  });

  it('serializes stale-lock recovery so a second contender cannot delete the winner', async () => {
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    const lock = pathInHarness(RUN_LOCK_FILENAME);
    writeFileSync(
      lock,
      JSON.stringify({
        harnessInstanceId: 'dead',
        processId: 999_999,
        acquiredAt: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );

    let contender: Promise<unknown> | undefined;
    const winner = await openCheckpointStore(runDir, {
      beforeStaleLockUnlink: () => {
        contender = openCheckpointStore(runDir);
        // Attach a handler immediately so the deliberately rejected promise
        // is never observed as an unhandled rejection before the assertion.
        void contender.catch(() => undefined);
      },
    });

    await expect(contender).rejects.toThrow(/already recovering the stale run lock/i);
    await winner.save(initializing(1));
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({
      processId: process.pid,
    });
    expect(existsSync(pathInHarness(RUN_LOCK_RECOVERY_FILENAME))).toBe(false);
    await winner.close();
  });

  it('fails closed when a stale-lock recovery guard survived an interrupted takeover', async () => {
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    const lock = pathInHarness(RUN_LOCK_FILENAME);
    const stale = {
      harnessInstanceId: 'dead',
      processId: 999_999,
      acquiredAt: new Date(0).toISOString(),
    };
    writeFileSync(lock, JSON.stringify(stale), { mode: 0o600 });
    writeFileSync(
      pathInHarness(RUN_LOCK_RECOVERY_FILENAME),
      JSON.stringify({ ...stale, harnessInstanceId: 'interrupted-recovery' }),
      { mode: 0o600 },
    );

    await expect(openCheckpointStore(runDir)).rejects.toThrow(
      /already recovering the stale run lock/i,
    );
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(stale);
  });

  it('poisons mutation after lock ownership is lost', async () => {
    const store = await openCheckpointStore(runDir);
    await store.save(initializing(1));
    const lock = pathInHarness(RUN_LOCK_FILENAME);
    const value = JSON.parse(readFileSync(lock, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      lock,
      JSON.stringify({ ...value, harnessInstanceId: 'another-owner' }),
      { mode: 0o600 },
    );

    await expect(store.save(initializing(2))).rejects.toThrow(/owned by another/);
    await expect(store.save(initializing(3))).rejects.toThrow(/owned by another/);
    expect(store.load()?.revision).toBe(1);
    await store.close();
  });

  it('reports a lock-release failure instead of silently claiming close succeeded', async () => {
    const store = await openCheckpointStore(runDir);
    const lock = pathInHarness(RUN_LOCK_FILENAME);
    rmSync(lock);
    mkdirSync(lock);

    await expect(store.close()).rejects.toThrow();
  });

  it('fails closed on a corrupt checkpoint and releases its newly acquired lock', async () => {
    const harnessDir = join(runDir, HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700 });
    chmodSync(harnessDir, 0o700);
    const checkpointPath = pathInHarness(RUN_CHECKPOINT_FILENAME);
    writeFileSync(checkpointPath, '{bad json', { mode: 0o600 });

    await expect(openCheckpointStore(runDir)).rejects.toThrow(/not valid JSON/);
    expect(existsSync(pathInHarness(RUN_LOCK_FILENAME))).toBe(false);

    writeFileSync(checkpointPath, JSON.stringify(initializing(1)), { mode: 0o600 });
    const reopened = await openCheckpointStore(runDir);
    expect(reopened.load()?.revision).toBe(1);
    await reopened.close();
  });

  it('rejects relative run directories and unsafe harness directory modes', async () => {
    await expect(openCheckpointStore('relative/run')).rejects.toThrow(/absolute/);
    mkdirSync(join(runDir, HARNESS_DIR), { mode: 0o755 });
    chmodSync(join(runDir, HARNESS_DIR), 0o755);
    await expect(openCheckpointStore(runDir)).rejects.toThrow(/mode/);
  });
});
