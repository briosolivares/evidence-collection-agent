import { z } from 'zod';

import { browserProviderKindSchema } from '../browser/sessionProvider.js';
import { outputContractSchema } from './initializer/outputContract.schema.js';
import type { Message } from '../model/messages.js';
import { MODEL_MAX_IMAGE_BYTES } from '../model/imageContent.js';
import type { ModelRole, RunBudgetSnapshot } from '../run/runBudget.js';
import { finishDefectSchema, finishFactsSchema } from './completion/finishFacts.schema.js';
import { VERIFICATION_HISTORY_LIMIT } from './verifier/verifier.js';
import {
  correctionFindingSchema,
  type VerificationHistoryEntry,
} from './verifier/verificationResult.schema.js';
import {
  durableFinishInputSchema,
  finishUnresolvedRequirementSchema,
} from '../tools/finish/finish.js';
import {
  MAX_PROTOCOL_CORRECTIONS,
  type FinishRequest,
  type PendingToolTurn,
  type WorkerSnapshot,
} from './worker/worker.js';

// The durable checkpoint format: every Zod shape the coordinator persists to
// and reads from harness/checkpoint.json, plus the types inferred from them.
// See checkpoint.ts for the store that opens, locks, and atomically writes
// this format, and for the imperative helpers around it.

/** The only checkpoint format understood by the coordinator. Declared here
 * (not in checkpoint.ts) because it is embedded in a schema literal below;
 * checkpoint.ts imports it back for nothing — it is schema-only. */
export const CHECKPOINT_VERSION = 3 as const;

/** Declared here (not in checkpoint.ts) because `serializedCeilingSchema`
 * below embeds it in a schema literal. checkpoint.ts imports it back for
 * `ceilingToCheckpoint`/`ceilingFromCheckpoint`, which is a one-directional
 * import (checkpoint.ts already depends on this module) rather than a cycle. */
export const UNBOUNDED_CEILING = 'unbounded' as const;

const MAX_SAFE_DIAGNOSTIC_LENGTH = 16_000;
const MAX_TASK_LENGTH = 1_000_000;

type JsonPrimitive = string | number | boolean | null;
export type CheckpointJson = JsonPrimitive | CheckpointJson[] | { [key: string]: CheckpointJson };

const jsonValueSchema: z.ZodType<CheckpointJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const isoTimestampSchema = z.string().refine((value) => {
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}, 'must be a canonical ISO 8601 timestamp');

const nonBlankString = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');

const serializedCeilingSchema = (minimum: number) =>
  z.union([z.number().int().min(minimum), z.literal(UNBOUNDED_CEILING)]);

const textBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});

const imageBlockSchema = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/png', 'image/jpeg']),
    data: z.string().max(4 * Math.ceil(MODEL_MAX_IMAGE_BYTES / 3)),
  }),
});

const toolUseBlockSchema = z
  .strictObject({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: jsonValueSchema,
  })
  .transform((block) => {
    if (block.name !== 'finish') return block;
    const parsed = durableFinishInputSchema.safeParse(block.input);
    return parsed.success ? { ...block, input: parsed.data } : block;
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

const modelRoles = ['initializer', 'worker', 'verifier'] as const satisfies readonly ModelRole[];

const roleUsageSchema = z.strictObject({
  turns: z.number().finite().nonnegative(),
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  cacheReadInputTokens: z.number().finite().nonnegative(),
  cacheCreationInputTokens: z.number().finite().nonnegative(),
  wallClockMs: z.number().finite().nonnegative(),
});

/** Exact durable form returned by captureRunBudgetSnapshot(). */
export const runBudgetSnapshotSchema: z.ZodType<RunBudgetSnapshot> = z.strictObject({
  elapsedWallTimeMs: z.number().finite().nonnegative(),
  roles: z.partialRecord(z.enum(modelRoles), roleUsageSchema),
  toolCalls: z.number().finite().nonnegative(),
  toolResultBytes: z.number().finite().nonnegative(),
  corrections: z.number().finite().nonnegative(),
});

export const durableRunConfigurationSchema = z.strictObject({
  /** Resume never has to infer the task from mutable or separately parsed state. */
  taskText: nonBlankString(MAX_TASK_LENGTH),
  model: nonBlankString(1_024),
  maxOutputTokens: z.number().int().positive(),
  maxContextTokens: serializedCeilingSchema(0),
  browserProvider: browserProviderKindSchema,
  authenticated: z.boolean(),
  javascriptPolicy: z.enum(['allow', 'deny']),
  startUrl: z.string().min(1).optional(),
  maxInitializerAttempts: z.number().int().min(1).max(2),
  maxCompletionCheckFailures: z.number().int().nonnegative(),
  budgetLimits: z.strictObject({
    maxWorkerTurns: serializedCeilingSchema(1),
    maxToolCalls: serializedCeilingSchema(0),
    maxModelTokens: serializedCeilingSchema(1),
    maxWallTimeMs: serializedCeilingSchema(1),
  }),
});

export type DurableRunConfiguration = z.infer<typeof durableRunConfigurationSchema>;

/** Initializer-only conversation state, absent before its first request. */
export const initializerProgressSchema = z.strictObject({
  messages: z.array(messageSchema).min(1),
  attempts: z.number().int().min(0).max(2),
  lastProblem: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH).optional(),
});

export type InitializerProgress = z.infer<typeof initializerProgressSchema>;

export const workerSnapshotSchema: z.ZodType<WorkerSnapshot> = z.strictObject({
  messages: z.array(messageSchema).min(1),
  turnCount: z.number().int().nonnegative(),
  peakContextTokens: z.number().int().nonnegative(),
  protocolCorrections: z.number().int().min(0).max(MAX_PROTOCOL_CORRECTIONS),
  startedMs: z.number().finite().nonnegative(),
});

const toolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonValueSchema,
});

export const pendingToolTurnSchema: z.ZodType<PendingToolTurn> = z
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

export const pendingFinishSchema: z.ZodType<FinishRequest> = z
  .strictObject({
    turn: z.number().int().positive(),
    call: z.strictObject({
      id: z.string().min(1),
      name: z.literal('finish'),
      input: durableFinishInputSchema,
    }),
    input: durableFinishInputSchema,
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

/** Verifying is intentionally restart-only. The verifier's private
 * conversation is not durable state: recovery reconstructs fresh context
 * from the task, contract, completion report, surfaced manifest entries,
 * structural facts/findings, and typed prior correction records, then reruns
 * the read-only verifier. */
export const pendingVerifierSchema = z.strictObject({
  cycle: z.number().int().positive(),
  recovery: z.literal('restart_read_only'),
});

export type PendingVerifier = z.infer<typeof pendingVerifierSchema>;

export const checkpointProgressSchema = z.strictObject({
  verifierCycles: z.number().int().nonnegative(),
  completionCheckFailures: z.number().int().nonnegative(),
  /** Highest durable steering-journal action incorporated into worker history.
   * Optional so existing version-3 checkpoints remain resumable. */
  steeringCursor: z.number().int().nonnegative().optional(),
});

export type CheckpointProgress = z.infer<typeof checkpointProgressSchema>;

const nonTerminalPhaseSchema = z.enum([
  'initializing',
  'ready_for_model',
  'executing_tool',
  'checking',
  'verifying',
]);

export const durableTerminalOutcomeSchema = z.discriminatedUnion('status', [
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
      'verification_incomplete',
      'budget_exceeded',
    ]),
    detail: nonBlankString(MAX_SAFE_DIAGNOSTIC_LENGTH),
    finalText: z.string(),
    unresolved: z.array(finishUnresolvedRequirementSchema).max(50).default([]),
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

export type DurableTerminalOutcome = z.infer<typeof durableTerminalOutcomeSchema>;

const checkpointCommonShape = {
  version: z.literal(CHECKPOINT_VERSION),
  revision: z.number().int().positive(),
  updatedAt: isoTimestampSchema,
  configuration: durableRunConfigurationSchema,
  budget: runBudgetSnapshotSchema,
  progress: checkpointProgressSchema,
} as const;

const initializingCheckpointSchema = z
  .strictObject({
    ...checkpointCommonShape,
    phase: z.literal('initializing'),
    contract: outputContractSchema.optional(),
    initializer: initializerProgressSchema.optional(),
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

const durableVerificationHistoryEntrySchema: z.ZodType<VerificationHistoryEntry> = z.strictObject({
  cycle: z.number().int().positive(),
  completionReport: durableFinishInputSchema,
  surfacedEvidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(correctionFindingSchema).min(1).max(50),
});

const activeCommonShape = {
  ...checkpointCommonShape,
  contract: outputContractSchema,
  worker: workerSnapshotSchema,
  verificationHistory: z
    .array(durableVerificationHistoryEntrySchema)
    .max(VERIFICATION_HISTORY_LIMIT)
    .optional(),
} as const;

const readyCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('ready_for_model'),
});

const executingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('executing_tool'),
  pendingTurn: pendingToolTurnSchema,
});

const checkingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('checking'),
  pendingFinish: pendingFinishSchema,
  pendingCheck: z.strictObject({
    status: z.literal('pending'),
    attempt: z.number().int().positive(),
  }),
});

const verifyingCheckpointSchema = z.strictObject({
  ...activeCommonShape,
  phase: z.literal('verifying'),
  pendingFinish: pendingFinishSchema,
  pendingCheck: z.strictObject({
    status: z.literal('passed'),
    attempt: z.number().int().positive(),
    facts: finishFactsSchema,
    structuralFindings: z.array(finishDefectSchema).optional(),
  }),
  pendingVerifier: pendingVerifierSchema,
});

const terminalCheckpointSchema = z
  .strictObject({
    ...checkpointCommonShape,
    phase: z.literal('terminal'),
    contract: outputContractSchema.optional(),
    worker: workerSnapshotSchema.optional(),
    /** Exact accepted finish claims, required for verified terminal recovery
     * so deterministic checks can be rerun against the current manifest. */
    finish: durableFinishInputSchema.optional(),
    outcome: durableTerminalOutcomeSchema,
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
export const checkpointSchema = z
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
      if (canonicalJson(trailingCalls) !== canonicalJson([checkpoint.pendingFinish.call])) {
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

export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointPhase = Checkpoint['phase'];

/** Shape of the exclusive run-lock file (checkpoint.ts owns reading, writing,
 * and staleness recovery for the file itself). */
export interface RunLockFile {
  harnessInstanceId: string;
  processId: number;
  acquiredAt: string;
}

export const runLockFileSchema: z.ZodType<RunLockFile> = z.strictObject({
  harnessInstanceId: z.string().min(1),
  processId: z.number().int().positive(),
  acquiredAt: isoTimestampSchema,
});

/** Deterministic JSON serialization with sorted object keys, used by
 * superRefine checks above (and by checkpoint.ts's save/lock-recovery
 * comparisons) to compare structural equality independent of key order.
 * `undefined` gets its own sentinel because `JSON.stringify(undefined)` is
 * `undefined`, not a string, which breaks `!==` comparison against a real
 * serialized value. */
export function canonicalJson(value: unknown): string {
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
