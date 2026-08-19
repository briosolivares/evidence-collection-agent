import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { OutputContract } from '../../src/agent/initializer/outputContract.js';
import type {
  AcceptedModelResponse,
  ModelDriver,
  ModelGenerateOptions,
} from '../../src/model/modelDriver.js';
import {
  createRegistry,
  type ToolDef,
} from '../../src/tools/registry.js';
import { writeArtifact } from '../../src/run/artifacts.js';
import type {
  V3Checkpoint,
  V3DurableRunConfiguration,
} from '../../src/agent/checkpoint.js';
import { runV3Coordinator } from '../../src/agent/lifecycle.js';

type Scenario =
  | 'contract'
  | 'model_in_flight'
  | 'pre_tool'
  | 'uncertain_tool'
  | 'post_tool'
  | 'cancelled_workspace_recovery'
  | 'verifying'
  | 'worker_accounting'
  | 'deterministic_feedback'
  | 'verifier_correction';
type Invocation = 'initial' | 'resume';

interface FixtureArguments {
  scenario: Scenario;
  invocation: Invocation;
  runDir: string;
  eventsPath: string;
}

interface FixtureEvent {
  type: string;
  scenario: Scenario;
  invocation: Invocation;
  processId: number;
  [key: string]: unknown;
}

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
  unresolved: [],
};

const CONFIGURATION: V3DurableRunConfiguration = {
  taskText: TASK,
  model: 'crash-fixture-worker',
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
    maxWallTimeMs: 120_000,
    maxVerifierCorrections: 2,
  },
};

const args = parseArguments(process.argv.slice(2));
let verifierCalls = 0;
let effectCalls = 0;

const effectTool: ToolDef<Record<string, never>> = {
  name: 'record_effect',
  description: 'Crash fixture tool that records one externally observable effect.',
  inputSchema: z.strictObject({}),
  getAccess: () => ({ reads: [], writes: ['fixture:effect'] }),
  async execute(_input, ctx) {
    effectCalls += 1;
    if (args.scenario === 'cancelled_workspace_recovery') {
      const workspaceFile = join(
        ctx.runDir,
        'scratch',
        'workspace',
        'killed-command.txt',
      );
      mkdirSync(dirname(workspaceFile), { recursive: true });
      writeFileSync(workspaceFile, 'bytes left by the killed tool\n', 'utf8');
    }
    appendEvent({ type: 'tool_effect' });
    await sendToParent({ type: 'tool_effect' });
    if (
      (args.scenario === 'uncertain_tool' ||
        args.scenario === 'cancelled_workspace_recovery') &&
      args.invocation === 'initial'
    ) {
      await hangUntilKilled();
    }
    return { recorded: true };
  },
};

const repairTool: ToolDef<Record<string, never>> = {
  name: 'repair_report',
  description: 'Crash fixture tool that restores the valid one-row report.',
  inputSchema: z.strictObject({}),
  getAccess: () => ({ reads: [], writes: ['fixture:report'] }),
  execute(_input, ctx) {
    writeArtifact(
      ctx.runDir,
      'artifacts/report.csv',
      Buffer.from('name\nAlice\n', 'utf8'),
      { roles: ['requested_output'] },
    );
    appendEvent({ type: 'report_repaired' });
    return { repaired: true };
  },
};

void main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  appendEvent({ type: 'fixture_error', message });
  try {
    await sendToParent({ type: 'fixture_error', message });
  } catch {
    // The parent may have intentionally killed or disconnected this fixture.
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const abort = new AbortController();
  if (
    args.scenario === 'cancelled_workspace_recovery' &&
    args.invocation === 'resume'
  ) {
    abort.abort(new DOMException('cancel before resume recovery', 'AbortError'));
  }
  const outcome = await runV3Coordinator({
    runDir: args.runDir,
    configuration: CONFIGURATION,
    initializerModel: initializerModel(),
    workerModel: workerModel(),
    verifierModel: verifierModel(),
    registry: createRegistry([effectTool, repairTool]),
    afterCheckpoint,
    ...(abort.signal.aborted ? { signal: abort.signal } : {}),
  });
  appendEvent({ type: 'outcome', outcome });
  await sendToParent({ type: 'outcome', outcome });
}

async function afterCheckpoint(checkpoint: V3Checkpoint): Promise<void> {
  appendEvent({
    type: 'checkpoint',
    phase: checkpoint.phase,
    revision: checkpoint.revision,
    ...(checkpoint.phase === 'executing_tool'
      ? {
          effect: checkpoint.pendingTurn.effect,
          nextCallIndex: checkpoint.pendingTurn.nextCallIndex,
        }
      : {}),
    verifierCalls,
  });

  if (args.invocation !== 'initial') return;

  if (
    args.scenario === 'contract' &&
    checkpoint.phase === 'initializing' &&
    checkpoint.contract !== undefined
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'accepted_contract',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }

  if (
    args.scenario === 'pre_tool' &&
    checkpoint.phase === 'executing_tool' &&
    checkpoint.pendingTurn.effect === 'not_started' &&
    checkpoint.pendingTurn.nextCallIndex === 0
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'pre_tool',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }

  if (
    (args.scenario === 'uncertain_tool' ||
      args.scenario === 'cancelled_workspace_recovery') &&
    checkpoint.phase === 'executing_tool' &&
    checkpoint.pendingTurn.effect === 'uncertain' &&
    checkpoint.pendingTurn.nextCallIndex === 0
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'uncertain_tool',
      revision: checkpoint.revision,
    });
    await waitForParentContinue();
  }

  if (
    args.scenario === 'verifying' &&
    checkpoint.phase === 'verifying' &&
    verifierCalls > 0
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'verifier_result_recorded',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }

  if (
    args.scenario === 'worker_accounting' &&
    checkpoint.phase === 'ready_for_model' &&
    checkpoint.worker.turnCount === 1 &&
    checkpoint.budget.roles.worker?.turns === 1
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'worker_accounting_recorded',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }

  const workerMessages =
    checkpoint.phase === 'initializing' || checkpoint.worker === undefined
      ? ''
      : JSON.stringify(checkpoint.worker.messages);
  if (
    args.scenario === 'post_tool' &&
    checkpoint.phase === 'ready_for_model' &&
    effectCalls === 1 &&
    workerMessages.includes('effect-once') &&
    workerMessages.includes('tool_result')
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'post_tool',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }
  if (
    args.scenario === 'deterministic_feedback' &&
    checkpoint.phase === 'ready_for_model' &&
    workerMessages.includes('deterministic_finish_checks')
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'deterministic_feedback_recorded',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }
  if (
    args.scenario === 'verifier_correction' &&
    checkpoint.phase === 'ready_for_model' &&
    workerMessages.includes('fixture_correction')
  ) {
    await sendToParent({
      type: 'boundary',
      boundary: 'verifier_correction_recorded',
      revision: checkpoint.revision,
    });
    await hangUntilKilled();
  }
}

function initializerModel(): ModelDriver {
  return {
    async generate() {
      appendEvent({ type: 'model_call', role: 'initializer' });
      return accepted([
        {
          type: 'tool_use',
          id: 'contract-report',
          name: 'set_output_contract',
          input: { contract: CONTRACT },
        },
      ]);
    },
  };
}

function workerModel(): ModelDriver {
  return {
    async generate(options: ModelGenerateOptions) {
      const serializedMessages = JSON.stringify(options.messages);
      const sawUncertainRecovery =
        serializedMessages.includes('Recovery did not replay') &&
        serializedMessages.includes('record_effect') &&
        serializedMessages.includes('uncertain');
      const sawDeterministicFeedback = serializedMessages.includes(
        'deterministic_finish_checks',
      );
      const sawVerifierCorrection = serializedMessages.includes(
        'fixture_correction',
      );
      const responseKind = (() => {
        if (
          (args.scenario === 'pre_tool' ||
            args.scenario === 'uncertain_tool' ||
            args.scenario === 'post_tool' ||
            args.scenario === 'cancelled_workspace_recovery') &&
          args.invocation === 'initial'
        ) {
          return 'effect' as const;
        }
        if (
          args.scenario === 'deterministic_feedback' &&
          sawDeterministicFeedback &&
          !serializedMessages.includes('repair-report')
        ) {
          return 'repair' as const;
        }
        return 'finish' as const;
      })();
      appendEvent({
        type: 'model_call',
        role: 'worker',
        responseKind,
        sawUncertainRecovery,
        sawDeterministicFeedback,
        sawVerifierCorrection,
      });
      if (
        args.scenario === 'model_in_flight' &&
        args.invocation === 'initial'
      ) {
        await sendToParent({ type: 'boundary', boundary: 'model_in_flight' });
        await hangUntilKilled();
      }
      if (responseKind === 'effect') {
        return accepted([
          {
            type: 'tool_use',
            id: 'effect-once',
            name: 'record_effect',
            input: {},
          },
        ]);
      }
      if (responseKind === 'repair') {
        return accepted([
          {
            type: 'tool_use',
            id: 'repair-report',
            name: 'repair_report',
            input: {},
          },
        ]);
      }
      return accepted([
        {
          type: 'tool_use',
          id: 'finish-report',
          name: 'finish',
          input: FINISH,
        },
      ]);
    },
  };
}

function verifierModel(): ModelDriver {
  return {
    async generate() {
      verifierCalls += 1;
      appendEvent({ type: 'model_call', role: 'verifier', verifierCalls });
      const correction =
        args.scenario === 'verifier_correction' && args.invocation === 'initial';
      return accepted([
        {
          type: 'tool_use',
          id: `verified-report-${verifierCalls}`,
          name: 'report_verification',
          input: correction
            ? {
                status: 'needs_correction',
                findings: [
                  {
                    kind: 'research',
                    requirement: 'fixture_correction: re-submit the exact published artifact.',
                    problem: 'Recovery has not observed the resubmission yet.',
                  },
                ],
              }
            : { status: 'verified', findings: [] },
        },
      ]);
    },
  };
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

function appendEvent(event: Omit<FixtureEvent, 'scenario' | 'invocation' | 'processId'>): void {
  appendFileSync(
    args.eventsPath,
    `${JSON.stringify({
      ...event,
      scenario: args.scenario,
      invocation: args.invocation,
      processId: process.pid,
    })}\n`,
    'utf8',
  );
}

function sendToParent(message: Record<string, unknown>): Promise<void> {
  if (process.send === undefined) {
    return Promise.reject(new Error('coordinator crash fixture requires an IPC parent'));
  }
  return new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function waitForParentContinue(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'continue'
      ) {
        process.off('message', onMessage);
        resolve();
      }
    };
    process.on('message', onMessage);
  });
}

function hangUntilKilled(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

function parseArguments(values: readonly string[]): FixtureArguments {
  const [scenario, invocation, runDir, eventsPath] = values;
  if (
    scenario !== 'contract' &&
    scenario !== 'model_in_flight' &&
    scenario !== 'pre_tool' &&
    scenario !== 'uncertain_tool' &&
    scenario !== 'post_tool' &&
    scenario !== 'cancelled_workspace_recovery' &&
    scenario !== 'verifying' &&
    scenario !== 'worker_accounting' &&
    scenario !== 'deterministic_feedback' &&
    scenario !== 'verifier_correction'
  ) {
    throw new Error(`invalid crash fixture scenario: ${String(scenario)}`);
  }
  if (invocation !== 'initial' && invocation !== 'resume') {
    throw new Error(`invalid crash fixture invocation: ${String(invocation)}`);
  }
  if (runDir === undefined || eventsPath === undefined) {
    throw new Error('crash fixture requires runDir and eventsPath arguments');
  }
  return { scenario, invocation, runDir, eventsPath };
}
