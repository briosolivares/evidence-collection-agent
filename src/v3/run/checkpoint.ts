import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import type { BrowserProviderKind } from '../../browser/sessionProvider.js';
import { outputContractSchema } from '../../contracts/outputContract.js';
import type { Message } from '../../loop/messages.js';
import { writeFileDurablyAtomic } from '../../run/atomicFile.js';
import type { ModelRole, RunBudgetSnapshot } from '../../run/runBudget.js';
import {
  v3FinishFactsSchema,
  type V3FinishFacts,
} from '../completion/types.js';
import { finishInputSchema } from '../tools/finish.js';
import type {
  V3FinishRequest,
  V3PendingToolTurn,
  V3WorkerSessionSnapshot,
} from '../loop/workerSession.js';

/** The only checkpoint format understood by the v3 coordinator. */
export const V3_CHECKPOINT_VERSION = 3 as const;
export const V3_UNBOUNDED_CEILING = 'unbounded' as const;

export const V3_HARNESS_DIR = 'harness';
export const V3_RUN_LOCK_FILENAME = 'run.lock';
export const V3_RUN_CHECKPOINT_FILENAME = 'checkpoint.json';
/** Finite pre-parse allocation ceiling for durable v3 checkpoint state. */
export const V3_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Short-lived compare/delete guard used only while replacing a stale run
 * lock. It is intentionally not auto-recovered: if a process dies in this
 * tiny critical section, a later operator must inspect the run instead of a
 * second process guessing that it is safe to delete another contender's
 * guard.
 */
export const V3_RUN_LOCK_RECOVERY_FILENAME = 'run.lock.recovery';

const HARNESS_DIR_MODE = 0o700;
const HARNESS_FILE_MODE = 0o600;
const CHECKPOINT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SAFE_DIAGNOSTIC_LENGTH = 16_000;
const MAX_TASK_LENGTH = 1_000_000;

type JsonPrimitive = string | number | boolean | null;
export type V3CheckpointJson =
  | JsonPrimitive
  | V3CheckpointJson[]
  | { [key: string]: V3CheckpointJson };

const jsonValueSchema: z.ZodType<V3CheckpointJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const isoTimestampSchema = z
  .string()
  .refine((value) => {
    const timestamp = Date.parse(value);
    return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
  }, 'must be a canonical ISO 8601 timestamp');

const nonBlankString = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');

const serializedCeilingSchema = (minimum: number) =>
  z.union([z.number().int().min(minimum), z.literal(V3_UNBOUNDED_CEILING)]);

export type V3SerializedCeiling = number | typeof V3_UNBOUNDED_CEILING;

export function v3CeilingToCheckpoint(value: number): V3SerializedCeiling {
  if (value === Infinity) return V3_UNBOUNDED_CEILING;
  if (!Number.isFinite(value)) {
    throw new Error(`cannot serialize non-finite checkpoint ceiling ${value}`);
  }
  return value;
}

export function v3CeilingFromCheckpoint(value: V3SerializedCeiling): number {
  return value === V3_UNBOUNDED_CEILING ? Infinity : value;
}

const textBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});

const imageBlockSchema = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/png', 'image/jpeg']),
    data: z.string(),
  }),
});

const toolUseBlockSchema = z.strictObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonValueSchema,
});

const toolResultBlockSchema = z.strictObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.union([textBlockSchema, imageBlockSchema]))]),
  is_error: z.literal(true).optional(),
});

const assistantMessageSchema = z.strictObject({
  role: z.literal('assistant'),
  content: z.array(z.union([textBlockSchema, toolUseBlockSchema])),
});

const userMessageSchema = z.strictObject({
  role: z.literal('user'),
  content: z.array(z.union([textBlockSchema, toolResultBlockSchema])),
});

const messageSchema: z.ZodType<Message> = z.discriminatedUnion('role', [
  userMessageSchema,
  assistantMessageSchema,
]);

const modelRoles = [
  'initializer',
  'worker',
  'verifier',
  'repair',
] as const satisfies readonly ModelRole[];

const roleUsageSchema = z.strictObject({
  turns: z.number().finite().nonnegative(),
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  cacheReadInputTokens: z.number().finite().nonnegative(),
  cacheCreationInputTokens: z.number().finite().nonnegative(),
  wallClockMs: z.number().finite().nonnegative(),
});

/** Exact durable form returned by captureRunBudgetSnapshot(). */
export const v3RunBudgetSnapshotSchema: z.ZodType<RunBudgetSnapshot> = z.strictObject({
  elapsedWallTimeMs: z.number().finite().nonnegative(),
  roles: z.partialRecord(z.enum(modelRoles), roleUsageSchema),
  toolCalls: z.number().finite().nonnegative(),
  toolResultBytes: z.number().finite().nonnegative(),
  corrections: z.number().finite().nonnegative(),
});

export const v3DurableRunConfigurationSchema = z.strictObject({
  /** Resume never has to infer the task from mutable or separately parsed state. */
  taskText: nonBlankString(MAX_TASK_LENGTH),
  model: nonBlankString(1_024),
  maxOutputTokens: z.number().int().positive(),
  maxContextTokens: serializedCeilingSchema(0),
  browserProvider: z.enum(['local', 'browserbase'] satisfies readonly BrowserProviderKind[]),
  authenticated: z.boolean(),
  javascriptPolicy: z.enum(['allow', 'deny']),
  startUrl: z.string().min(1).optional(),
  maxInitializerAttempts: z.number().int().min(1).max(2),
  maxCompletionCheckFailures: z.number().int().nonnegative(),
  budgetLimits: z.strictObject({
    maxWorkerTurns: serializedCeilingSchema(1),
    maxToolCalls: serializedCeilingSchema(0),
    maxModelTokens: serializedCeilingSchema(1),
    maxToolResultBytes: serializedCeilingSchema(0),
    maxWallTimeMs: serializedCeilingSchema(1),
    maxVerifierCorrections: serializedCeilingSchema(0),
  }),
});

export type V3DurableRunConfiguration = z.infer<
  typeof v3DurableRunConfigurationSchema
>;

type DeepReadonly<T> = T extends readonly (infer Child)[]
  ? readonly DeepReadonly<Child>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** Detached, recursively frozen configuration observed before resume opens
 * the mutating checkpoint store. The coordinator still re-reads and
 * revalidates the complete checkpoint after acquiring the run lock. */
export type V3ReadonlyDurableRunConfiguration =
  DeepReadonly<V3DurableRunConfiguration>;

/** Minimal, immutable composition-time view used to route a v3 resume
 * without exposing or mutating the checkpoint's actionable cargo. */
export interface V3CheckpointResumeInfo {
  readonly phase: V3CheckpointPhase;
  readonly configuration: V3ReadonlyDurableRunConfiguration;
}

/** Initializer-only conversation state, absent before its first request. */
export const v3InitializerProgressSchema = z.strictObject({
  messages: z.array(messageSchema).min(1),
  attempts: z.number().int().min(0).max(2),
  lastProblem: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH).optional(),
});

export type V3InitializerProgress = z.infer<typeof v3InitializerProgressSchema>;

export const v3WorkerSessionSnapshotSchema: z.ZodType<V3WorkerSessionSnapshot> =
  z.strictObject({
    messages: z.array(messageSchema).min(1),
    turnCount: z.number().int().nonnegative(),
    peakContextTokens: z.number().int().nonnegative(),
    protocolCorrections: z.number().int().nonnegative(),
    startedMs: z.number().finite().nonnegative(),
  });

const toolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonValueSchema,
});

export const v3PendingToolTurnSchema: z.ZodType<V3PendingToolTurn> = z
  .strictObject({
    turn: z.number().int().positive(),
    assistant: assistantMessageSchema,
    calls: z.array(toolCallSchema).min(1),
    completedResults: z.array(toolResultBlockSchema),
    nextCallIndex: z.number().int().nonnegative(),
    effect: z.enum(['not_started', 'uncertain']),
  })
  .superRefine((pending, ctx) => {
    if (pending.nextCallIndex > pending.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextCallIndex'],
        message: 'must not exceed calls.length',
      });
    }
    if (pending.completedResults.length !== pending.nextCallIndex) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedResults'],
        message: 'must contain exactly one ordered result for every completed call',
      });
    }
    pending.completedResults.forEach((result, index) => {
      if (result.tool_use_id !== pending.calls[index]?.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['completedResults', index, 'tool_use_id'],
          message: 'must match the call id at the same index',
        });
      }
    });
    const assistantCalls = pending.assistant.content
      .filter((block) => block.type === 'tool_use')
      .map(({ id, name, input }) => ({ id, name, input }));
    if (canonicalJson(assistantCalls) !== canonicalJson(pending.calls)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'must exactly match the assistant tool calls in response order',
      });
    }
    if (pending.effect === 'uncertain' && pending.nextCallIndex >= pending.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['effect'],
        message: 'cannot be uncertain when no next call exists',
      });
    }
    pending.calls.forEach((call, index) => {
      if (call.name === 'finish') {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'name'],
          message: 'finish is coordinator state and cannot be an executing ordinary tool',
        });
      }
    });
  });

export const v3PendingFinishSchema: z.ZodType<V3FinishRequest> = z
  .strictObject({
    turn: z.number().int().positive(),
    call: z.strictObject({
      id: z.string().min(1),
      name: z.literal('finish'),
      input: finishInputSchema,
    }),
    input: finishInputSchema,
    assistantText: z.string(),
  })
  .superRefine((pending, ctx) => {
    if (canonicalJson(pending.call.input) !== canonicalJson(pending.input)) {
      ctx.addIssue({
        code: 'custom',
        path: ['call', 'input'],
        message: 'must equal the validated finish input',
      });
    }
  });

/** State saved before deterministic checks, or their passed verifier facts. */
export const v3PendingCheckSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('pending'),
    attempt: z.number().int().positive(),
  }),
  z.strictObject({
    status: z.literal('passed'),
    attempt: z.number().int().positive(),
    facts: v3FinishFactsSchema,
  }),
]);

export type V3PendingCheck =
  | { status: 'pending'; attempt: number }
  | { status: 'passed'; attempt: number; facts: V3FinishFacts };

/** Verifying is intentionally restart-only. The verifier's private
 * conversation is not durable state: recovery reconstructs fresh context
 * from the task, contract, finish claims, clarifications, and settled facts,
 * then reruns the read-only verifier. */
export const v3PendingVerifierSchema = z.strictObject({
  cycle: z.number().int().positive(),
  recovery: z.literal('restart_read_only'),
});

export type V3PendingVerifier = z.infer<typeof v3PendingVerifierSchema>;

export const v3CheckpointProgressSchema = z.strictObject({
  verifierCycles: z.number().int().nonnegative(),
  completionCheckFailures: z.number().int().nonnegative(),
});

export type V3CheckpointProgress = z.infer<typeof v3CheckpointProgressSchema>;

const nonTerminalPhaseSchema = z.enum([
  'initializing',
  'ready_for_model',
  'executing_tool',
  'checking',
  'verifying',
]);

export const v3DurableTerminalOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    finalText: z.string(),
  }),
  z.strictObject({
    status: z.literal('incomplete'),
    during: nonTerminalPhaseSchema,
    reason: z.enum([
      'initializer_unavailable',
      'worker_incomplete',
      'completion_check_attempts',
      'verifier_unavailable',
      'verification_attempts',
      'budget_exceeded',
    ]),
    detail: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH),
    finalText: z.string(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    during: nonTerminalPhaseSchema,
    message: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    during: nonTerminalPhaseSchema,
    reason: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH),
  }),
]);

export type V3DurableTerminalOutcome = z.infer<
  typeof v3DurableTerminalOutcomeSchema
>;

const checkpointCommonShape = {
  version: z.literal(V3_CHECKPOINT_VERSION),
  revision: z.number().int().positive(),
  updatedAt: isoTimestampSchema,
  configuration: v3DurableRunConfigurationSchema,
  budget: v3RunBudgetSnapshotSchema,
  progress: v3CheckpointProgressSchema,
} as const;

const initializingCheckpointSchema = z
  .strictObject({
    ...checkpointCommonShape,
    phase: z.literal('initializing'),
    contract: outputContractSchema.optional(),
    initializer: v3InitializerProgressSchema.optional(),
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.contract !== undefined && checkpoint.initializer !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['initializer'],
        message: 'must be absent once the immutable contract has been accepted',
      });
    }
    if (
      checkpoint.initializer !== undefined &&
      checkpoint.initializer.attempts > checkpoint.configuration.maxInitializerAttempts
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['initializer', 'attempts'],
        message: 'must not exceed configuration.maxInitializerAttempts',
      });
    }
  });

const activeCommonShape = {
  ...checkpointCommonShape,
  contract: outputContractSchema,
  worker: v3WorkerSessionSnapshotSchema,
} as const;

const readyCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('ready_for_model'),
});

const executingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('executing_tool'),
  pendingTurn: v3PendingToolTurnSchema,
});

const checkingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('checking'),
  pendingFinish: v3PendingFinishSchema,
  pendingCheck: z.strictObject({
    status: z.literal('pending'),
    attempt: z.number().int().positive(),
  }),
});

const verifyingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('verifying'),
  pendingFinish: v3PendingFinishSchema,
  pendingCheck: z.strictObject({
    status: z.literal('passed'),
    attempt: z.number().int().positive(),
    facts: v3FinishFactsSchema,
  }),
  pendingVerifier: v3PendingVerifierSchema,
});

const terminalCheckpointSchema = z
  .strictObject({
    ...checkpointCommonShape,
    phase: z.literal('terminal'),
    contract: outputContractSchema.optional(),
    worker: v3WorkerSessionSnapshotSchema.optional(),
    /** Exact accepted finish claims, required for verified terminal recovery
     * so deterministic checks can be rerun against the current manifest. */
    finish: finishInputSchema.optional(),
    outcome: v3DurableTerminalOutcomeSchema,
  })
  .superRefine((checkpoint, ctx) => {
    const stoppedDuringInitialization =
      (checkpoint.outcome.status === 'incomplete' &&
        checkpoint.outcome.during === 'initializing') ||
      ((checkpoint.outcome.status === 'failed' || checkpoint.outcome.status === 'cancelled') &&
        checkpoint.outcome.during === 'initializing');
    if (
      !stoppedDuringInitialization &&
      (checkpoint.contract === undefined || checkpoint.worker === undefined)
    ) {
      if (checkpoint.contract === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['contract'],
          message: 'is required for a terminal run that progressed beyond initialization',
        });
      }
      if (checkpoint.worker === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['worker'],
          message: 'is required for a terminal run that progressed beyond initialization',
        });
      }
    }
    if (checkpoint.outcome.status === 'verified') {
      if (checkpoint.finish === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['finish'],
          message: 'is required for a verified terminal run',
        });
      } else if (checkpoint.finish.summary !== checkpoint.outcome.finalText) {
        ctx.addIssue({
          code: 'custom',
          path: ['finish', 'summary'],
          message: 'must equal the verified outcome finalText',
        });
      } else if (checkpoint.worker !== undefined) {
        const trailing = trailingAssistantMessage(checkpoint.worker.messages);
        const finishCalls = trailing?.content
          .filter((block) => block.type === 'tool_use')
          .map(({ name, input }) => ({ name, input }));
        if (
          canonicalJson(finishCalls) !==
          canonicalJson([{ name: 'finish', input: checkpoint.finish }])
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['finish'],
            message:
              'must equal the sole unanswered finish call in the trailing worker assistant message',
          });
        }
      }
    } else if (checkpoint.finish !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['finish'],
        message: 'is permitted only for a verified terminal run',
      });
    }
  });

/**
 * Strict, phase-discriminated durable state. Phase-specific cargo cannot leak
 * into another phase and be mistaken for actionable resume state.
 */
export const v3CheckpointSchema = z
  .discriminatedUnion('phase', [
    initializingCheckpointSchema,
    readyCheckpointSchema,
    executingCheckpointSchema,
    checkingCheckpointSchema,
    verifyingCheckpointSchema,
    terminalCheckpointSchema,
  ])
  .superRefine((checkpoint, ctx) => {
    const conversation =
      checkpoint.phase === 'initializing'
        ? checkpoint.initializer?.messages
        : checkpoint.worker?.messages;
    if (
      conversation !== undefined &&
      openingTaskText(conversation) !== checkpoint.configuration.taskText
    ) {
      ctx.addIssue({
        code: 'custom',
        path:
          checkpoint.phase === 'initializing'
            ? ['initializer', 'messages']
            : ['worker', 'messages'],
        message: 'opening task text must equal configuration.taskText',
      });
    }
    if (
      checkpoint.phase === 'executing_tool' &&
      checkpoint.pendingTurn.turn !== checkpoint.worker.turnCount
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pendingTurn', 'turn'],
        message: 'must equal worker.turnCount',
      });
    }
    if (checkpoint.phase === 'executing_tool') {
      const trailing = trailingAssistantMessage(checkpoint.worker.messages);
      if (canonicalJson(trailing) !== canonicalJson(checkpoint.pendingTurn.assistant)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingTurn', 'assistant'],
          message: 'must exactly equal the trailing worker assistant message',
        });
      }
    }
    if (
      (checkpoint.phase === 'checking' || checkpoint.phase === 'verifying') &&
      checkpoint.pendingFinish.turn !== checkpoint.worker.turnCount
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['pendingFinish', 'turn'],
        message: 'must equal worker.turnCount',
      });
    }
    if (checkpoint.phase === 'checking' || checkpoint.phase === 'verifying') {
      const trailing = trailingAssistantMessage(checkpoint.worker.messages);
      const trailingCalls = trailing?.content
        .filter((block) => block.type === 'tool_use')
        .map(({ id, name, input }) => ({ id, name, input }));
      if (
        canonicalJson(trailingCalls) !==
        canonicalJson([checkpoint.pendingFinish.call])
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingFinish', 'call'],
          message:
            'must be the sole tool call in the trailing worker assistant message, with identical id, name, and input',
        });
      }
      if (assistantText(trailing) !== checkpoint.pendingFinish.assistantText) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingFinish', 'assistantText'],
          message: 'must equal the text in the trailing worker assistant message',
        });
      }
    }
  });

export type V3Checkpoint = z.infer<typeof v3CheckpointSchema>;
export type V3CheckpointPhase = V3Checkpoint['phase'];

const VALID_PHASE_TRANSITIONS: Readonly<
  Record<V3CheckpointPhase, readonly V3CheckpointPhase[]>
> = {
  initializing: ['initializing', 'ready_for_model', 'terminal'],
  ready_for_model: [
    'ready_for_model',
    'executing_tool',
    'checking',
    'terminal',
  ],
  executing_tool: ['executing_tool', 'ready_for_model', 'terminal'],
  checking: ['ready_for_model', 'verifying', 'terminal'],
  verifying: ['verifying', 'ready_for_model', 'terminal'],
  terminal: [],
};

interface RunLockFile {
  harnessInstanceId: string;
  processId: number;
  acquiredAt: string;
}

const runLockFileSchema: z.ZodType<RunLockFile> = z.strictObject({
  harnessInstanceId: z.string().min(1),
  processId: z.number().int().positive(),
  acquiredAt: isoTimestampSchema,
});

export interface V3CheckpointStoreOptions {
  now?: () => number;
  /** Queue/serialization test seam, before ownership is rechecked. */
  beforeWrite?: () => void | Promise<void>;
  /** Concurrency test seam invoked while the stale-lock recovery guard is held. */
  beforeStaleLockUnlink?: () => void;
  /** Crash-window test seam: flushed temp exists, destination is unchanged. */
  afterTempFileSync?: (tempPath: string) => void;
}

export interface V3CheckpointStore {
  load(): V3Checkpoint | undefined;
  save(checkpoint: V3Checkpoint): Promise<void>;
  close(): Promise<void>;
}

/**
 * Read only the durable checkpoint format discriminator for resume routing.
 * This intentionally does not validate format-specific cargo: after routing,
 * the selected v1 or v3 loader must validate the complete checkpoint under
 * its own rules. The shared reader still enforces the private directory/file
 * contract, byte ceiling, no-follow behavior, and valid JSON before a version
 * is returned.
 */
export function readRunCheckpointVersion(
  runDir: string,
): 1 | typeof V3_CHECKPOINT_VERSION {
  assertRealRunDirectory(runDir);
  const harnessDir = existingHarnessDirectory(runDir);
  const checkpointPath = join(harnessDir, V3_RUN_CHECKPOINT_FILENAME);
  const raw = readCheckpointText(checkpointPath);
  if (raw === undefined) {
    throw new Error(`checkpoint does not exist at ${checkpointPath}`);
  }
  const value = parseJson(raw, `checkpoint at ${checkpointPath}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `checkpoint at ${checkpointPath} has no supported version discriminator`,
    );
  }

  const envelope = value as Record<string, unknown>;
  const hasLegacyVersion = Object.hasOwn(envelope, 'schemaVersion');
  const hasV3Version = Object.hasOwn(envelope, 'version');
  if (hasLegacyVersion && hasV3Version) {
    throw new Error(
      `checkpoint at ${checkpointPath} has ambiguous version discriminators`,
    );
  }
  if (hasLegacyVersion) {
    if (envelope.schemaVersion !== 1) {
      throw new Error(
        `checkpoint at ${checkpointPath} has unsupported schemaVersion ` +
          JSON.stringify(envelope.schemaVersion),
      );
    }
    return 1;
  }
  if (hasV3Version) {
    if (envelope.version !== V3_CHECKPOINT_VERSION) {
      throw new Error(
        `checkpoint at ${checkpointPath} has unsupported version ` +
          JSON.stringify(envelope.version),
      );
    }
    return V3_CHECKPOINT_VERSION;
  }
  throw new Error(
    `checkpoint at ${checkpointPath} has no supported version discriminator`,
  );
}

/**
 * Observe the immutable configuration of an existing v3 run without taking
 * its lock or changing any run-directory state. This is deliberately only a
 * composition-time hint: resume must still open the checkpoint store and
 * revalidate the checkpoint under its exclusive lock before doing work.
 *
 * The complete checkpoint is read through the same schema as the store, with
 * a finite byte ceiling and no-follow regular-file checks. The returned value
 * is detached from the parsed checkpoint and recursively frozen.
 */
export function readV3CheckpointConfiguration(
  runDir: string,
): V3ReadonlyDurableRunConfiguration {
  return readV3CheckpointResumeInfo(runDir).configuration;
}

/** Observe the checkpoint phase together with its immutable configuration.
 * Terminal resumes use this hint to avoid constructing a new external trace;
 * the coordinator still re-reads and validates the full checkpoint under its
 * exclusive run lock before trusting either value. */
export function readV3CheckpointResumeInfo(
  runDir: string,
): Readonly<V3CheckpointResumeInfo> {
  assertRealRunDirectory(runDir);
  const harnessDir = existingHarnessDirectory(runDir);
  const checkpointPath = join(harnessDir, V3_RUN_CHECKPOINT_FILENAME);
  const checkpoint = readCheckpointFile(checkpointPath);
  if (checkpoint === undefined) {
    throw new Error(`v3 checkpoint does not exist at ${checkpointPath}`);
  }
  return Object.freeze({
    phase: checkpoint.phase,
    configuration: deepFreeze(checkpoint.configuration),
  });
}

/**
 * Open one exclusively locked v3 checkpoint store. Saves are schema-checked,
 * serialized, monotonic, configuration/contract immutable, and published via
 * fsync + same-directory atomic rename + parent-directory fsync.
 */
export async function openV3CheckpointStore(
  runDir: string,
  options: V3CheckpointStoreOptions = {},
): Promise<V3CheckpointStore> {
  assertRealRunDirectory(runDir);

  const now = options.now ?? Date.now;
  const harnessDir = ensureHarnessDirectory(runDir);
  const checkpointPath = join(harnessDir, V3_RUN_CHECKPOINT_FILENAME);
  const instanceId = randomUUID();

  acquireRunLock(
    harnessDir,
    instanceId,
    now,
    options.beforeStaleLockUnlink,
  );

  let seed: V3Checkpoint | undefined;
  try {
    seed = readCheckpointFile(checkpointPath);
  } catch (error) {
    releaseRunLock(harnessDir, instanceId);
    throw error;
  }

  let lastRevision = seed?.revision;
  let lastPhase = seed?.phase;
  let durableConfiguration = seed?.configuration;
  let durableContract = seed?.contract;
  let poisonedError: Error | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let queueTail: Promise<void> = Promise.resolve();

  async function performSave(checkpoint: V3Checkpoint): Promise<void> {
    if (lastRevision !== undefined && checkpoint.revision <= lastRevision) {
      throw new Error(
        `checkpoint revision ${checkpoint.revision} must be strictly greater than ` +
          `the last saved revision ${lastRevision}`,
      );
    }
    if (
      lastPhase !== undefined &&
      !VALID_PHASE_TRANSITIONS[lastPhase].includes(checkpoint.phase)
    ) {
      throw new Error(
        `invalid v3 checkpoint phase transition ${lastPhase} -> ${checkpoint.phase}; ` +
          (lastPhase === 'terminal'
            ? 'terminal is absorbing'
            : `allowed next phases are ${VALID_PHASE_TRANSITIONS[lastPhase].join(', ')}`),
      );
    }

    if (
      durableConfiguration !== undefined &&
      canonicalJson(checkpoint.configuration) !== canonicalJson(durableConfiguration)
    ) {
      throw new Error('refusing to change immutable v3 run configuration');
    }
    if (durableContract !== undefined) {
      if (checkpoint.contract === undefined) {
        throw new Error('refusing to remove the accepted immutable output contract');
      }
      if (canonicalJson(checkpoint.contract) !== canonicalJson(durableContract)) {
        throw new Error('refusing to change the accepted immutable output contract');
      }
    }

    assertRunLockOwner(harnessDir, instanceId);
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    writeFileDurablyAtomic(checkpointPath, serialized, {
      fileMode: HARNESS_FILE_MODE,
      ...(options.afterTempFileSync === undefined
        ? {}
        : { afterTempFileSync: options.afterTempFileSync }),
    });

    lastRevision = checkpoint.revision;
    lastPhase = checkpoint.phase;
    durableConfiguration = checkpoint.configuration;
    durableContract = checkpoint.contract;
  }

  return {
    load: () => readCheckpointFile(checkpointPath),

    save(checkpoint: V3Checkpoint): Promise<void> {
      if (closed) return Promise.reject(new Error('v3 checkpoint store is already closed'));
      if (poisonedError !== undefined) return Promise.reject(poisonedError);

      const parsed = v3CheckpointSchema.safeParse(checkpoint);
      if (!parsed.success) {
        return Promise.reject(
          new Error(`refusing to save an invalid v3 checkpoint:\n${formatZodIssues(parsed.error)}`),
        );
      }
      // Zod returns fresh containers, preventing caller mutation while this
      // save waits behind an earlier queued write.
      const validated = parsed.data;
      const task = queueTail.then(async () => {
        if (poisonedError !== undefined) throw poisonedError;
        await options.beforeWrite?.();
        try {
          await performSave(validated);
        } catch (error) {
          if (isLockOwnershipError(error)) {
            poisonedError = error instanceof Error ? error : new Error(String(error));
          }
          throw error;
        }
      });
      queueTail = task.catch(() => undefined);
      return task;
    },

    close(): Promise<void> {
      if (closePromise === undefined) {
        closed = true;
        closePromise = queueTail.then(() => releaseRunLock(harnessDir, instanceId));
      }
      return closePromise;
    },
  };
}

function assertRealRunDirectory(runDir: string): void {
  if (!isAbsolute(runDir)) {
    throw new Error(`v3 checkpoint runDir must be absolute: ${runDir}`);
  }
  const runStats = lstatSync(runDir);
  if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
    throw new Error(`v3 checkpoint runDir must be a real directory: ${runDir}`);
  }
}

function existingHarnessDirectory(runDir: string): string {
  const harnessDir = join(runDir, V3_HARNESS_DIR);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(harnessDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`v3 checkpoint harness directory does not exist: ${harnessDir}`);
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${harnessDir} must be a real directory`);
  }
  const mode = stats.mode & 0o777;
  if (mode !== HARNESS_DIR_MODE) {
    throw new Error(
      `${harnessDir} has mode 0${mode.toString(8)}, expected 0${HARNESS_DIR_MODE.toString(8)}`,
    );
  }
  return harnessDir;
}

function ensureHarnessDirectory(runDir: string): string {
  const harnessDir = join(runDir, V3_HARNESS_DIR);
  try {
    const stats = lstatSync(harnessDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${harnessDir} must be a real directory`);
    }
    const mode = stats.mode & 0o777;
    if (mode !== HARNESS_DIR_MODE) {
      throw new Error(
        `${harnessDir} has mode 0${mode.toString(8)}, expected 0${HARNESS_DIR_MODE.toString(8)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(harnessDir, { mode: HARNESS_DIR_MODE });
    chmodSync(harnessDir, HARNESS_DIR_MODE);
  }
  return harnessDir;
}

function lockPath(harnessDir: string): string {
  return join(harnessDir, V3_RUN_LOCK_FILENAME);
}

function recoveryLockPath(harnessDir: string): string {
  return join(harnessDir, V3_RUN_LOCK_RECOVERY_FILENAME);
}

function acquireRunLock(
  harnessDir: string,
  instanceId: string,
  now: () => number,
  beforeStaleLockUnlink?: () => void,
): void {
  const path = lockPath(harnessDir);
  const lock: RunLockFile = {
    harnessInstanceId: instanceId,
    processId: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  const serialized = `${JSON.stringify(lock, null, 2)}\n`;

  const tryCreate = (): boolean => {
    try {
      writeFileDurablyAtomic(path, serialized, {
        mode: 'create',
        fileMode: HARNESS_FILE_MODE,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  if (tryCreate()) return;
  const existing = readRunLock(path);
  if (existing !== undefined && processIsLive(existing.processId)) {
    throw new Error(
      `run is already open: lock held by pid ${existing.processId} ` +
        `(instance ${existing.harnessInstanceId})`,
    );
  }

  const recoveryPath = recoveryLockPath(harnessDir);
  const recoveryLock: RunLockFile = {
    harnessInstanceId: instanceId,
    processId: process.pid,
    acquiredAt: new Date(now()).toISOString(),
  };
  try {
    writeFileDurablyAtomic(
      recoveryPath,
      `${JSON.stringify(recoveryLock, null, 2)}\n`,
      { mode: 'create', fileMode: HARNESS_FILE_MODE },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `another process is already recovering the stale run lock at ${path}`,
      );
    }
    throw error;
  }

  let acquired = false;
  try {
    // Re-read under the recovery guard. A lock that changed since the first
    // observation may belong to a new live contender and must never be
    // removed merely because the prior inode was stale.
    const current = readRunLock(path);
    if (canonicalJson(current) !== canonicalJson(existing)) {
      throw new Error(
        `run lock at ${path} changed during stale-lock recovery; refusing to remove it`,
      );
    }
    if (current !== undefined && processIsLive(current.processId)) {
      throw new Error(
        `run is already open: lock held by pid ${current.processId} ` +
          `(instance ${current.harnessInstanceId})`,
      );
    }

    beforeStaleLockUnlink?.();
    if (current !== undefined) unlinkSync(path);
    acquired = tryCreate();
    if (!acquired) {
      throw new Error(`another process claimed ${path} during stale-lock recovery`);
    }
  } finally {
    try {
      releaseRecoveryLock(harnessDir, instanceId);
    } catch (error) {
      // Do not return a store while its recovery guard could strand every
      // future opener. Relinquish the just-created run lock when possible and
      // surface the cleanup failure.
      if (acquired) {
        try {
          releaseRunLock(harnessDir, instanceId);
        } catch {
          // The recovery-lock failure remains the primary invariant breach.
        }
      }
      throw error;
    }
  }
}

function assertRunLockOwner(harnessDir: string, instanceId: string): void {
  let current: RunLockFile | undefined;
  try {
    current = readRunLock(lockPath(harnessDir));
  } catch (error) {
    throw new V3LockOwnershipError(
      `could not validate the v3 run lock in ${harnessDir}: ${errorMessage(error)}`,
    );
  }
  if (current?.harnessInstanceId !== instanceId) {
    throw new V3LockOwnershipError(
      `v3 run lock in ${harnessDir} is missing or owned by another instance`,
    );
  }
}

function releaseRunLock(harnessDir: string, instanceId: string): void {
  const path = lockPath(harnessDir);
  const current = readRunLock(path);
  if (current === undefined) {
    throw new V3LockOwnershipError(
      `v3 run lock in ${harnessDir} disappeared before it could be released`,
    );
  }
  // A reassigned lock is not ours to remove. The save path already poisons
  // this store when ownership changes; close must preserve the new owner.
  if (current.harnessInstanceId !== instanceId) return;
  unlinkSync(path);
}

function releaseRecoveryLock(harnessDir: string, instanceId: string): void {
  const path = recoveryLockPath(harnessDir);
  const current = readRunLock(path);
  if (current?.harnessInstanceId !== instanceId) {
    throw new V3LockOwnershipError(
      `v3 stale-lock recovery guard in ${harnessDir} is missing or owned by another instance`,
    );
  }
  unlinkSync(path);
}

function readRunLock(path: string): RunLockFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsedJson = parseJson(raw, `run lock at ${path}`);
  const parsed = runLockFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`run lock at ${path} failed validation:\n${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function readCheckpointFile(path: string): V3Checkpoint | undefined {
  const raw = readCheckpointText(path);
  if (raw === undefined) return undefined;
  const parsedJson = parseJson(raw, `checkpoint at ${path}`);
  const parsed = v3CheckpointSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `checkpoint at ${path} failed v3 schema validation; refusing to start fresh:\n` +
        formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}

function readCheckpointText(path: string): string | undefined {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(
      `checkpoint at ${path} must be a regular file; symlinks are not followed`,
    );
  }

  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`checkpoint at ${path} must be a regular file`);
    }
    const mode = opened.mode & 0o777;
    if (mode !== HARNESS_FILE_MODE) {
      throw new Error(
        `checkpoint at ${path} has mode 0${mode.toString(8)}, ` +
          `expected 0${HARNESS_FILE_MODE.toString(8)}`,
      );
    }
    if (opened.size > V3_CHECKPOINT_MAX_BYTES) {
      throw checkpointSizeLimitError(path, opened.size);
    }

    const bytes = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        total,
        Math.min(CHECKPOINT_READ_CHUNK_BYTES, bytes.byteLength - total),
        null,
      );
      if (count === 0) break;
      total += count;
    }

    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = readSync(descriptor, overflowProbe, 0, 1, null);
    const after = fstatSync(descriptor);
    if (after.size > V3_CHECKPOINT_MAX_BYTES) {
      throw checkpointSizeLimitError(path, Math.max(after.size, total + overflow));
    }
    if (
      overflow !== 0 ||
      total !== opened.size ||
      after.size !== opened.size
    ) {
      throw new Error(`checkpoint at ${path} changed while it was being read`);
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function checkpointSizeLimitError(path: string, observedBytes: number): Error {
  return new Error(
    `checkpoint at ${path} is ${observedBytes} bytes, exceeding the ` +
      `${V3_CHECKPOINT_MAX_BYTES}-byte read limit`,
  );
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

class V3LockOwnershipError extends Error {}

function isLockOwnershipError(error: unknown): boolean {
  return error instanceof V3LockOwnershipError;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '<undefined>';
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function openingTaskText(messages: readonly Message[]): string | undefined {
  const first = messages[0];
  if (first?.role !== 'user') return undefined;
  const block = first.content[0];
  return block?.type === 'text' ? block.text : undefined;
}

function trailingAssistantMessage(
  messages: readonly Message[],
): Extract<Message, { role: 'assistant' }> | undefined {
  const trailing = messages.at(-1);
  return trailing?.role === 'assistant' ? trailing : undefined;
}

function assistantText(
  message: Extract<Message, { role: 'assistant' }> | undefined,
): string | undefined {
  if (message === undefined) return undefined;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.');
      return `- at ${path}: ${issue.message}`;
    })
    .join('\n');
}
