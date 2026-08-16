import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserController } from '../../browser/controller.js';
import type { OutputContract } from '../../contracts/outputContract.js';
import type { ToolResultBlock } from '../../loop/messages.js';
import {
  ModelGenerationFailedError,
  type AcceptedModelResponse,
  type ModelDriver,
  type ModelGenerateOptions,
} from '../../model/modelDriver.js';
import {
  initManifest,
  readManifest,
  writeArtifact,
} from '../../run/artifacts.js';
import {
  ARTIFACT_WRITE_JOURNAL_PATH,
  commitArtifactWriteTransaction,
} from '../../run/artifactWriteTransaction.js';
import { createRegistry } from '../../tools/registry.js';
import {
  V3_RUN_CHECKPOINT_FILENAME,
  V3_HARNESS_DIR,
  v3CheckpointSchema,
  type V3Checkpoint,
  type V3DurableRunConfiguration,
} from './checkpoint.js';
import { runV3Coordinator } from './coordinator.js';
import { V3_OUTPUT_CONTRACT_PATH } from './outputContractFile.js';

const TASK = 'Publish report.csv with exactly one name column and one row.';

const CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [{ type: 'exact_row_count', value: 1 }],
    },
  ],
};

const FINISH = {
  summary: 'Published the requested one-row report.',
  limitations: [],
};

const CONFIGURATION: V3DurableRunConfiguration = {
  taskText: TASK,
  model: 'test-worker-model',
  maxOutputTokens: 4_096,
  maxContextTokens: 100_000,
  browserProvider: 'local',
  authenticated: false,
  javascriptPolicy: 'allow',
  maxInitializerAttempts: 2,
  maxCompletionCheckFailures: 2,
  budgetLimits: {
    maxWorkerTurns: 10,
    maxToolCalls: 20,
    maxModelTokens: 100_000,
    maxToolResultBytes: 1_000_000,
    maxWallTimeMs: 1_000_000,
    maxVerifierCorrections: 2,
  },
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-coordinator-'));
  initManifest(runDir, TASK, 'local');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runV3Coordinator', () => {
  it('runs initializer, worker finish checks, and verifier to one durable verified outcome', async () => {
    publishValidRunArtifacts();
    const models = happyModels();

    const outcome = await run(models);

    expect(outcome).toEqual({
      status: 'verified',
      finalText: FINISH.summary,
    });
    expect(models.initializer.generate).toHaveBeenCalledOnce();
    expect(models.worker.generate).toHaveBeenCalledOnce();
    expect(models.verifier.generate).toHaveBeenCalledOnce();

    const checkpoint = readCheckpoint();
    expect(checkpoint).toMatchObject({ phase: 'terminal', outcome });
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expect(existsSync(join(runDir, V3_OUTPUT_CONTRACT_PATH))).toBe(true);
    expect(
      JSON.stringify(
        vi.mocked(models.worker.generate).mock.calls[0]?.[0].messages,
      ),
    ).toContain('JavaScript policy is allow for this run');
  });

  it('puts a deny decision in per-run guidance without changing the static prefix', async () => {
    publishValidRunArtifacts();
    const models = happyModels();

    const outcome = await run(models, {
      configuration: { ...CONFIGURATION, javascriptPolicy: 'deny' },
    });

    expect(outcome.status).toBe('verified');
    const opening = JSON.stringify(
      vi.mocked(models.worker.generate).mock.calls[0]?.[0].messages,
    );
    expect(opening).toContain('browser_execute is disabled in its entirety');
    expect(opening).toContain('Do not call or retry browser_execute');
  });

  it('ends incomplete when the initializer model is unavailable', async () => {
    const initializerFailure = new ModelGenerationFailedError(
      new Error('initializer transport unavailable'),
      { input_tokens: 7, output_tokens: 2 },
    );
    const initializer = scriptedDriver([initializerFailure]);
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await run({ initializer, worker, verifier });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'initializer_unavailable',
      detail: expect.stringContaining('initializer transport unavailable'),
      finalText: '',
    });
    expect(initializer.generate).toHaveBeenCalledOnce();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'incomplete', reason: 'initializer_unavailable' },
    });
  });

  it('classifies an internal initializer AbortError as unavailable, not cancelled', async () => {
    const initializer = scriptedDriver([
      new DOMException('initializer provider aborted internally', 'AbortError'),
    ]);
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await run({ initializer, worker, verifier });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      during: 'initializing',
      reason: 'initializer_unavailable',
      detail: expect.stringContaining('initializer provider aborted internally'),
    });
    expect(outcome).not.toMatchObject({ status: 'cancelled' });
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
  });

  it('durably terminalizes initializer budget exhaustion without a contract or worker', async () => {
    const initializer = scriptedDriver([initializerAccepted()]);
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await run(
      { initializer, worker, verifier },
      {
        configuration: {
          ...CONFIGURATION,
          budgetLimits: {
            ...CONFIGURATION.budgetLimits,
            maxModelTokens: 1,
          },
        },
      },
    );

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
      detail: expect.stringContaining('model_tokens'),
      finalText: '',
    });
    expect(initializer.generate).toHaveBeenCalledOnce();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    const checkpoint = readCheckpoint();
    expect(checkpoint).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'incomplete', reason: 'budget_exceeded' },
    });
    if (checkpoint.phase !== 'terminal') throw new Error('expected terminal checkpoint');
    expect(checkpoint.contract).toBeUndefined();
    expect(checkpoint.worker).toBeUndefined();
  });

  it('terminalizes a resume whose wall deadline elapsed entirely during downtime', async () => {
    const configuration: V3DurableRunConfiguration = {
      ...CONFIGURATION,
      budgetLimits: {
        ...CONFIGURATION.budgetLimits,
        maxWallTimeMs: 100,
      },
    };
    const checkpoint: V3Checkpoint = v3CheckpointSchema.parse({
      version: 3,
      revision: 1,
      updatedAt: new Date(Date.now() - 1_000).toISOString(),
      configuration,
      budget: {
        elapsedWallTimeMs: 10,
        roles: {},
        toolCalls: 0,
        toolResultBytes: 0,
        corrections: 0,
      },
      progress: { verifierCycles: 0, completionCheckFailures: 0 },
      phase: 'initializing',
    });
    const harnessDir = join(runDir, V3_HARNESS_DIR);
    mkdirSync(harnessDir, { mode: 0o700, recursive: true });
    writeFileSync(
      join(harnessDir, V3_RUN_CHECKPOINT_FILENAME),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      { mode: 0o600 },
    );
    const initializer = unexpectedDriver('initializer');
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await run(
      { initializer, worker, verifier },
      { configuration },
    );

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
      detail: expect.stringContaining('wall_time'),
    });
    expect(initializer.generate).not.toHaveBeenCalled();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      outcome: { status: 'incomplete', reason: 'budget_exceeded' },
    });
  });

  it('charges the initializer control call to the whole-run tool budget', async () => {
    const initializer = scriptedDriver([initializerAccepted()]);
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');

    const outcome = await run(
      { initializer, worker, verifier },
      {
        configuration: {
          ...CONFIGURATION,
          budgetLimits: {
            ...CONFIGURATION.budgetLimits,
            maxToolCalls: 0,
          },
        },
      },
    );

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'budget_exceeded',
      detail: expect.stringContaining('tool_calls'),
    });
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(readCheckpoint()).toMatchObject({
      phase: 'terminal',
      budget: { toolCalls: 1 },
      outcome: { status: 'incomplete', reason: 'budget_exceeded' },
    });
  });

  it('checks terminal-run integrity without invoking a model or browser', async () => {
    publishValidRunArtifacts();
    const firstOutcome = await run(happyModels());
    const initializer = unexpectedDriver('initializer');
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');
    const closeTaskPages = vi.fn(async () => undefined);
    const browser = { closeTaskPages } as unknown as BrowserController;

    await expect(
      run({ initializer, worker, verifier }, { browser }),
    ).resolves.toEqual(firstOutcome);
    expect(initializer.generate).not.toHaveBeenCalled();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(closeTaskPages).not.toHaveBeenCalled();

    writeFileSync(join(runDir, 'artifacts/report.csv'), 'name\nTampered\n');
    await expect(
      run({ initializer, worker, verifier }, { browser }),
    ).rejects.toThrow(/manifest|hash|changed after/i);
    expect(initializer.generate).not.toHaveBeenCalled();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
    expect(closeTaskPages).not.toHaveBeenCalled();
  });

  it('bounds terminal resume inspection independently of the completed run budget', async () => {
    publishValidRunArtifacts();
    await run(happyModels());
    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };
    let now = 0;

    await expect(
      run(models, {
        now: () => now++,
        terminalResumeInspectionTimeoutMs: 2,
      }),
    ).rejects.toThrow(/terminal resume inspection exceeded.*2ms/i);
    expect(models.initializer.generate).not.toHaveBeenCalled();
    expect(models.worker.generate).not.toHaveBeenCalled();
    expect(models.verifier.generate).not.toHaveBeenCalled();
  });

  it('honors cancellation before fresh-run recovery or manifest inspection', async () => {
    const abort = new AbortController();
    const stopped = new Error('operator stopped before resume inspection');
    abort.abort(stopped);
    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };

    await expect(run(models, { signal: abort.signal })).resolves.toMatchObject({
      status: 'cancelled',
      reason: stopped.message,
    });
    expect(models.initializer.generate).not.toHaveBeenCalled();
    expect(models.worker.generate).not.toHaveBeenCalled();
    expect(models.verifier.generate).not.toHaveBeenCalled();
  });

  it('finishes pending artifact recovery before terminalizing preflight cancellation', async () => {
    const bytes = Buffer.from('recovered evidence\n', 'utf8');
    const filename = 'artifacts/recovered.txt';
    expect(() =>
      commitArtifactWriteTransaction(
        runDir,
        {
          filename,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          capturedAt: new Date().toISOString(),
          roles: ['evidence'],
        },
        bytes,
        {
          afterArtifactCommitted: () => {
            throw new Error('simulated death after artifact commit');
          },
        },
      ),
    ).toThrow(/simulated death/);
    const journalDir = join(runDir, ARTIFACT_WRITE_JOURNAL_PATH);
    expect(readdirSync(journalDir)).not.toEqual([]);

    const abort = new AbortController();
    abort.abort(new Error('cancel before active recovery'));
    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };
    await expect(run(models, { signal: abort.signal })).resolves.toMatchObject({
      status: 'cancelled',
    });

    expect(readManifest(runDir)).toMatchObject({
      finishedAt: expect.any(String),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ filename }),
      ]),
    });
    expect(readdirSync(journalDir)).toEqual([]);
  });

  it('refuses a verified terminal run whose manifest forgets a requested output', async () => {
    publishValidRunArtifacts();
    await run(happyModels());

    const manifest = readManifest(runDir);
    manifest.artifacts = manifest.artifacts.filter(
      (entry) => entry.filename !== 'artifacts/report.csv',
    );
    writeFileSync(
      join(runDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const initializer = unexpectedDriver('initializer');
    const worker = unexpectedDriver('worker');
    const verifier = unexpectedDriver('verifier');
    await expect(run({ initializer, worker, verifier })).rejects.toThrow(
      /no manifest entry|requested output|deterministic checks/i,
    );
    expect(initializer.generate).not.toHaveBeenCalled();
    expect(worker.generate).not.toHaveBeenCalled();
    expect(verifier.generate).not.toHaveBeenCalled();
  });

  it('repairs terminal transcript and manifest finalization after a post-checkpoint crash', async () => {
    publishValidRunArtifacts();
    await expect(
      run(happyModels(), {
        afterCheckpoint: (checkpoint) => {
          if (checkpoint.phase === 'terminal') {
            throw new Error('simulated death after terminal checkpoint');
          }
        },
      }),
    ).rejects.toThrow(/simulated death/);

    const durable = readCheckpoint();
    expect(durable.phase).toBe('terminal');
    expect(readManifest(runDir).finishedAt).toBeUndefined();
    expect(terminalTranscriptEvents()).toHaveLength(0);
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(false);
    appendFileSync(
      join(runDir, 'transcript.jsonl'),
      '{"type":"v3_run_terminal"',
      'utf8',
    );

    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };
    await expect(run(models)).resolves.toEqual(
      durable.phase === 'terminal' ? durable.outcome : undefined,
    );
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(true);
    expect(terminalTranscriptEvents()).toHaveLength(1);
    expect(models.initializer.generate).not.toHaveBeenCalled();
    expect(models.worker.generate).not.toHaveBeenCalled();
    expect(models.verifier.generate).not.toHaveBeenCalled();
  });

  it('attempts manifest finalization even when complete transcript history is corrupt', async () => {
    publishValidRunArtifacts();
    await expect(
      run(happyModels(), {
        afterCheckpoint: (checkpoint) => {
          if (checkpoint.phase === 'terminal') {
            throw new Error('simulated death before terminal projections');
          }
        },
      }),
    ).rejects.toThrow(/simulated death/);
    appendFileSync(join(runDir, 'transcript.jsonl'), 'not-json\n', 'utf8');

    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };
    await expect(run(models)).rejects.toThrow(
      /terminal projection repair.*transcript.*not valid JSON/i,
    );
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expect(existsSync(join(runDir, 'metrics.json'))).toBe(true);
  });

  it('retries a failed terminal metrics projection without suppressing transcript or manifest', async () => {
    publishValidRunArtifacts();
    const metricsPath = join(runDir, 'metrics.json');
    mkdirSync(metricsPath);

    await expect(run(happyModels())).rejects.toThrow(
      /terminal projection repair.*metrics/i,
    );
    const durable = readCheckpoint();
    expect(durable).toMatchObject({
      phase: 'terminal',
      outcome: {
        status: 'verified',
      },
    });
    expect(readManifest(runDir).finishedAt).toBeDefined();
    expect(terminalTranscriptEvents()).toHaveLength(1);

    rmSync(metricsPath, { recursive: true });
    const models = {
      initializer: unexpectedDriver('initializer'),
      worker: unexpectedDriver('worker'),
      verifier: unexpectedDriver('verifier'),
    };
    await expect(run(models)).resolves.toEqual(
      durable.phase === 'terminal' ? durable.outcome : undefined,
    );
    expect(existsSync(metricsPath)).toBe(true);
  });

  it('makes the accepted contract checkpoint durable before publishing its immutable file', async () => {
    publishValidRunArtifacts();
    const acceptedFileVisibility: boolean[] = [];
    const readyFileVisibility: boolean[] = [];

    const outcome = await run(happyModels(), {
      afterCheckpoint: (checkpoint) => {
        const contractFileExists = existsSync(
          join(runDir, V3_OUTPUT_CONTRACT_PATH),
        );
        if (checkpoint.phase === 'initializing' && checkpoint.contract !== undefined) {
          acceptedFileVisibility.push(contractFileExists);
        }
        if (checkpoint.phase === 'ready_for_model') {
          readyFileVisibility.push(contractFileExists);
        }
      },
    });

    expect(outcome.status).toBe('verified');
    expect(acceptedFileVisibility).toEqual([false]);
    expect(readyFileVisibility.length).toBeGreaterThan(0);
    expect(readyFileVisibility.every(Boolean)).toBe(true);
  });

  it('answers the exhausted deterministic finish once in the terminal worker snapshot', async () => {
    const models = {
      initializer: scriptedDriver([initializerAccepted()]),
      worker: scriptedDriver([workerFinished()]),
      verifier: unexpectedDriver('verifier'),
    };

    const outcome = await run(models, {
      configuration: {
        ...CONFIGURATION,
        maxCompletionCheckFailures: 1,
      },
    });

    expect(outcome).toMatchObject({
      status: 'incomplete',
      reason: 'completion_check_attempts',
      finalText: FINISH.summary,
    });
    expect(models.verifier.generate).not.toHaveBeenCalled();

    const checkpoint = readCheckpoint();
    expect(checkpoint.phase).toBe('terminal');
    if (checkpoint.phase !== 'terminal') throw new Error('expected terminal checkpoint');
    const finishResults = checkpoint.worker?.messages.flatMap((message) =>
      message.role === 'user'
        ? message.content.filter(
            (block): block is ToolResultBlock =>
              block.type === 'tool_result' &&
              block.tool_use_id === 'finish-report',
          )
        : [],
    );
    expect(finishResults).toHaveLength(1);
    expect(finishResults?.[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'finish-report',
      is_error: true,
    });
    expect(JSON.stringify(finishResults?.[0]?.content)).toContain(
      'deterministic_finish_checks',
    );
    expect(checkpoint.worker?.messages.at(-1)?.role).toBe('user');
  });
});

function run(
  models: {
    initializer: ModelDriver;
    worker: ModelDriver;
    verifier: ModelDriver;
  },
  overrides: {
    configuration?: V3DurableRunConfiguration;
    browser?: BrowserController;
    afterCheckpoint?: (checkpoint: V3Checkpoint) => void | Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
    terminalResumeInspectionTimeoutMs?: number;
  } = {},
) {
  return runV3Coordinator({
    runDir,
    configuration: overrides.configuration ?? CONFIGURATION,
    initializerModel: models.initializer,
    workerModel: models.worker,
    verifierModel: models.verifier,
    registry: createRegistry([]),
    ...(overrides.browser === undefined ? {} : { browser: overrides.browser }),
    ...(overrides.afterCheckpoint === undefined
      ? {}
      : { afterCheckpoint: overrides.afterCheckpoint }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.terminalResumeInspectionTimeoutMs === undefined
      ? {}
      : {
          terminalResumeInspectionTimeoutMs:
            overrides.terminalResumeInspectionTimeoutMs,
        }),
  });
}

function happyModels() {
  return {
    initializer: scriptedDriver([initializerAccepted()]),
    worker: scriptedDriver([workerFinished()]),
    verifier: scriptedDriver([verifierAccepted()]),
  };
}

function initializerAccepted(): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: 'contract-report',
      name: 'set_output_contract',
      input: { contract: CONTRACT },
    },
  ]);
}

function workerFinished(): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: 'finish-report',
      name: 'finish',
      input: FINISH,
    },
  ]);
}

function verifierAccepted(): AcceptedModelResponse {
  return accepted([
    {
      type: 'tool_use',
      id: 'verified-report',
      name: 'report_verification',
      input: { status: 'verified', findings: [] },
    },
  ]);
}

function accepted(
  content: AcceptedModelResponse['response']['content'],
): AcceptedModelResponse {
  const usage = {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  };
  return {
    response: { content, stop_reason: 'tool_use', usage },
    stopReason: 'tool_use',
    attempts: 1,
    usage,
  };
}

function scriptedDriver(
  steps: Array<AcceptedModelResponse | Error>,
): ModelDriver & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(async (_options: ModelGenerateOptions) => {
    const step = steps.shift();
    if (step === undefined) throw new Error('scripted model exhausted');
    if (step instanceof Error) throw step;
    return step;
  });
  return { generate };
}

function unexpectedDriver(
  role: string,
): ModelDriver & { generate: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn(async () => {
      throw new Error(`${role} model must not be called`);
    }),
  };
}

function publishValidRunArtifacts(): void {
  writeArtifact(
    runDir,
    'artifacts/report.csv',
    Buffer.from('name\nAlice\n', 'utf8'),
    { roles: ['requested_output'] },
  );
  writeArtifact(
    runDir,
    'artifacts/evidence.png',
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      roles: ['evidence'],
      sourceUrl: 'https://example.test/source',
    },
  );
}

function readCheckpoint(): V3Checkpoint {
  return v3CheckpointSchema.parse(
    JSON.parse(
      readFileSync(
        join(runDir, V3_HARNESS_DIR, V3_RUN_CHECKPOINT_FILENAME),
        'utf8',
      ),
    ),
  );
}

function terminalTranscriptEvents(): unknown[] {
  try {
    return readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string })
      .filter((event) => event.type === 'v3_run_terminal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
