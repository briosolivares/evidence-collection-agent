import { Buffer } from 'node:buffer';

import { z } from 'zod';

import type { OutputContract } from '../initializer/outputContract.js';
import type {
  CallModel,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../../model/messages.js';
import {
  createAnthropicModelDriver,
  type ModelAttemptEvent,
  type ModelDriver,
  type ModelDriverConfig,
} from '../../model/modelDriver.js';
import type { RunBudgetTracker } from '../../run/runBudget.js';
import { verifierPrompt } from '../../prompts/index.js';
import {
  toApiToolDefs,
  type ApiToolDef,
  type ToolCtx,
} from '../../tools/registry.js';
import type {
  FinishDefect,
  FinishFacts,
  OutputFact,
  SettledFact,
  TableFact,
} from '../completion/finishChecks.js';
import { finishInputSchema } from '../../tools/finish/finish.js';
import {
  RoleBudgetExceededError,
  createBudgetedCallModel,
  isRoleBudgetExceededError,
} from '../../model/budgetedCall.js';
import {
  createVerifierPathPolicy,
  createVerifierRegistry,
  executeVerifierToolUses,
} from './tools.js';

export const VERIFIER_MODEL = 'claude-haiku-4-5-20251001';
export const VERIFIER_MAX_CONTEXT_TOKENS = 150_000;
export const VERIFICATION_HISTORY_LIMIT = 20;

const boundedNonBlank = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');

const requirementProblemShape = {
  requirement: boundedNonBlank(4_000),
  problem: boundedNonBlank(4_000),
} as const;

/** The verifier identifies the unsupported requirement; it never prescribes
 * artifact contents. The harness attaches a fixed research instruction. */
export const researchFindingSchema = z.strictObject({
  kind: z.literal('research'),
  ...requirementProblemShape,
});

/** Permitted only when the cited, already-surfaced evidence supports the
 * repair. An "unavailable" note is never support for a synthetic row. */
export const artifactRepairFindingSchema = z.strictObject({
  kind: z.literal('artifact_repair'),
  ...requirementProblemShape,
  evidencePaths: z.array(boundedNonBlank(1_024)).min(1).max(50),
});

/** Restricted to correcting the worker's own summary/unresolved report; it
 * cannot change artifacts or erase a material blocker. */
export const reportRepairFindingSchema = z.strictObject({
  kind: z.literal('report_repair'),
  ...requirementProblemShape,
});

export const correctionFindingSchema = z.discriminatedUnion('kind', [
  researchFindingSchema,
  artifactRepairFindingSchema,
  reportRepairFindingSchema,
]);

export const incompleteFindingSchema = z.strictObject({
  requirement: boundedNonBlank(4_000),
  assessment: boundedNonBlank(4_000),
  evidencePaths: z.array(boundedNonBlank(1_024)).max(50).optional(),
});

export type CorrectionFinding = z.infer<typeof correctionFindingSchema>;
export type IncompleteFinding = z.infer<typeof incompleteFindingSchema>;

export const verificationResultSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('verified'),
      findings: z.array(z.never()).max(0),
    }),
  z
    .strictObject({
      status: z.literal('needs_correction'),
      findings: z.array(correctionFindingSchema).min(1).max(50),
    }),
  z
    .strictObject({
      status: z.literal('incomplete'),
      findings: z.array(incompleteFindingSchema).min(1).max(50),
    }),
]);

export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerifierOutcome =
  | VerificationResult
  | { status: 'verifier_unavailable'; reason: string }
  | { status: 'invalid_verdict'; reason: string };

export const surfacedArtifactSchema = z.strictObject({
  filename: boundedNonBlank(1_024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: boundedNonBlank(8_192).optional(),
  roles: z.array(z.enum(['requested_output', 'evidence'])).min(1).max(2),
  capturedAt: boundedNonBlank(128),
  completionStatus: z.enum(['complete', 'partial']).optional(),
});

export type SurfacedArtifact = z.infer<typeof surfacedArtifactSchema>;

export const verificationHistoryEntrySchema = z.strictObject({
  cycle: z.number().int().positive(),
  completionReport: finishInputSchema,
  surfacedEvidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(correctionFindingSchema).min(1).max(50),
});

export type VerificationHistoryEntry = z.infer<
  typeof verificationHistoryEntrySchema
>;

export const REPORT_VERIFICATION_TOOL: ApiToolDef = {
  name: 'report_verification',
  description:
    'Report exactly one evidence-backed decision. Use verified only when every explicit ' +
    'requirement is supported, needs_correction only for a typed research/artifact_repair/' +
    'report_repair finding, or incomplete for a credible blocker where another equivalent ' +
    'retry is unlikely to help.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['verified', 'needs_correction', 'incomplete'],
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['research', 'artifact_repair', 'report_repair'],
            },
            requirement: { type: 'string' },
            problem: { type: 'string' },
            assessment: { type: 'string' },
            evidencePaths: { type: 'array', items: { type: 'string' } },
          },
          required: ['requirement'],
          additionalProperties: false,
        },
      },
    },
    required: ['status', 'findings'],
    additionalProperties: false,
  },
};

const FORCED_REPORT_PROMPT =
  'Your inspection budget is exhausted. No further inspection calls will be ' +
  'executed. Based only on what you already verified, respond now with one ' +
  'report_verification call. Treat every unverified criterion as unproven.';

const REPAIR_SUFFIX =
  'Respond again with one valid report_verification call and no other tool calls.';

export const VERIFIER_API_TOOL_DEFS: readonly ApiToolDef[] = deepFreeze([
  ...toApiToolDefs(createVerifierRegistry()),
  structuredClone(REPORT_VERIFICATION_TOOL),
]);

export interface VerifierModelConfig {
  model?: string;
  maxOutputTokens?: number;
  maxTokensRetryOutputTokens?: number;
  createStream?: ModelDriverConfig['createStream'];
}

export function createVerifierModelDriver(
  config: VerifierModelConfig = {},
): ModelDriver {
  return createAnthropicModelDriver({
    model: config.model ?? VERIFIER_MODEL,
    system: verifierPrompt,
    apiToolDefs: VERIFIER_API_TOOL_DEFS,
    maxOutputTokens: config.maxOutputTokens ?? 2_048,
    ...(config.maxTokensRetryOutputTokens === undefined
      ? {}
      : { maxTokensRetryOutputTokens: config.maxTokensRetryOutputTokens }),
    ...(config.createStream === undefined
      ? {}
      : { createStream: config.createStream }),
  });
}

export interface RunVerifierOptions {
  taskText: string;
  runDir: string;
  contract: OutputContract;
  finish: FinishFacts['finish'];
  surfacedArtifacts: readonly SurfacedArtifact[];
  settled?: readonly SettledFact[];
  /** Passed-check output facts, used only to render informational per-column
   * nonblank coverage counts (never a threshold) alongside the settled row
   * count. */
  outputs?: readonly OutputFact[];
  structuralFindings?: readonly FinishDefect[];
  verificationHistory?: readonly VerificationHistoryEntry[];
  model: ModelDriver;
  budget: RunBudgetTracker;
  signal?: AbortSignal;
  onEvent?: (event: ModelAttemptEvent) => void;
  /** Durable accounting boundary invoked after each model/tool charge. */
  afterAccounting?: () => void | Promise<void>;
  now?: () => number;
}

export class VerifierAccountingPersistenceError extends Error {
  override readonly name = 'VerifierAccountingPersistenceError';
}

export function isVerifierAccountingPersistenceError(
  error: unknown,
): error is VerifierAccountingPersistenceError {
  return error instanceof VerifierAccountingPersistenceError;
}

/** Run the preserved read-only fresh verifier with aggregate accounting
 * and one immutable contract revision. */
export function runVerifier(
  options: RunVerifierOptions,
): Promise<VerifierOutcome> {
  options.signal?.throwIfAborted();
  const callModel = createBudgetedCallModel({
    model: options.model,
    budget: options.budget,
    role: 'verifier',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    onAcceptedResponse: (response) => {
      options.budget.recordToolCalls(
        response.content.filter((block) => block.type === 'tool_use').length,
      );
    },
    ...(options.afterAccounting === undefined
      ? {}
      : {
          afterAttemptSettled: () => persistVerifierAccounting(options),
        }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return runVerifierLoop(options, callModel);
}

async function runVerifierLoop(
  options: RunVerifierOptions,
  callModel: CallModel,
): Promise<VerifierOutcome> {
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: buildVerifierOpeningInput(options) }],
    },
  ];
  const pathPolicy = createVerifierPathPolicy(
    options.surfacedArtifacts.map((artifact) => artifact.filename),
  );
  const registry = createVerifierRegistry(pathPolicy);
  const toolCtx: ToolCtx = {
    runDir: options.runDir,
    ...(options.signal === undefined
      ? {}
      : { abortSignal: options.signal }),
  };
  let repairUsed = false;
  let forced = false;

  for (;;) {
    let response;
    try {
      response = await callModel(messages);
    } catch (error) {
      if (
        isAbortError(error) ||
        options.signal?.aborted === true ||
        isRoleBudgetExceededError(error) ||
        isVerifierAccountingPersistenceError(error)
      ) {
        throw error;
      }
      return unavailable(
        `verifier model call failed: ${errorMessage(error)}`,
      );
    }

    options.signal?.throwIfAborted();
    messages.push({ role: 'assistant', content: response.content });
    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    const reports = toolUses.filter(
      (block) => block.name === REPORT_VERIFICATION_TOOL.name,
    );

    if (reports.length > 0) {
      const structuralProblem =
        reports.length > 1
          ? 'more than one report_verification call in one response'
          : toolUses.length > 1
            ? 'report_verification must be the only tool call in its response'
            : undefined;
      if (structuralProblem !== undefined) {
        if (repairUsed || forced) return invalidVerdict(structuralProblem);
        repairUsed = true;
        await appendRepair(
          options,
          messages,
          toolUses,
          'Not executed: the report response was invalid.',
          `Invalid report: ${structuralProblem}. ${REPAIR_SUFFIX}`,
        );
        continue;
      }

      const parsed = verificationResultSchema.safeParse(reports[0]!.input);
      const validityProblem = parsed.success
        ? findVerificationValidityProblem(parsed.data, options)
        : parsed.error.message;
      if (parsed.success && validityProblem === undefined) {
        return parsed.data;
      }
      if (repairUsed || forced) {
        return invalidVerdict(
          `invalid report_verification input: ${validityProblem}`,
        );
      }
      repairUsed = true;
      await appendRepair(
        options,
        messages,
        toolUses,
        'Not executed: the report was structurally invalid.',
        `Your report_verification input failed validation: ${validityProblem}. ${REPAIR_SUFFIX}`,
      );
      continue;
    }

    if (toolUses.length === 0) {
      if (repairUsed || forced) {
        return invalidVerdict(
          'verifier ended without a valid report_verification call',
        );
      }
      repairUsed = true;
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Your response contained no report_verification call. Prose is ' +
              `never a verdict. ${REPAIR_SUFFIX} If inspection is still needed, ` +
              'make only those tool calls first.',
          },
        ],
      });
      continue;
    }

    if (forced) {
      return invalidVerdict(
        'verifier kept requesting tools after its inspection budget was exhausted',
      );
    }

    if (responseContextTokens(response.usage) > VERIFIER_MAX_CONTEXT_TOKENS) {
      forced = true;
      const results = closeToolUses(
        toolUses,
        "Not executed: the verifier's inspection budget is exhausted.",
      );
      await accountVerifierResults(options, results);
      messages.push({
        role: 'user',
        content: [
          ...results,
          { type: 'text', text: FORCED_REPORT_PROMPT },
        ],
      });
      continue;
    }

    const results = await executeVerifierToolUses(
      registry,
      toolUses,
      toolCtx,
      pathPolicy,
    );
    await accountVerifierResults(options, results);
    messages.push({ role: 'user', content: results });
  }
}

async function appendRepair(
  options: RunVerifierOptions,
  messages: Message[],
  toolUses: readonly ToolUseBlock[],
  closedMessage: string,
  correction: string,
): Promise<void> {
  const results = closeToolUses(toolUses, closedMessage);
  await accountVerifierResults(options, results);
  messages.push({
    role: 'user',
    content: [...results, { type: 'text', text: correction }],
  });
}

async function accountVerifierResults(
  options: RunVerifierOptions,
  results: readonly ToolResultBlock[],
): Promise<void> {
  options.budget.recordToolResultBytes(verifierResultBytes(results));
  await persistVerifierAccounting(options);
  throwIfVerifierBudgetExceeded(options.budget);
}

function closeToolUses(
  toolUses: readonly ToolUseBlock[],
  message: string,
): ToolResultBlock[] {
  return toolUses.map((block) => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: message,
    is_error: true,
  }));
}

function responseContextTokens(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function unavailable(reason: string): VerifierOutcome {
  return { status: 'verifier_unavailable', reason };
}

function invalidVerdict(reason: string): VerifierOutcome {
  return { status: 'invalid_verdict', reason };
}

/** Additional runtime validity that the parsed shape alone cannot express:
 * `verified` is impossible while unresolved/structural facts remain, and an
 * `artifact_repair` may only cite evidence that is actually surfaced. */
function findVerificationValidityProblem(
  result: VerificationResult,
  options: Pick<
    RunVerifierOptions,
    'finish' | 'structuralFindings' | 'surfacedArtifacts'
  >,
): string | undefined {
  if (
    result.status === 'verified' &&
    (options.finish.unresolved.length > 0 ||
      (options.structuralFindings?.length ?? 0) > 0)
  ) {
    return (
      'verified is never valid while unresolved requirements or objective ' +
      'structural findings remain. If the reported blockers are credible, ' +
      'return incomplete with one finding per blocked requirement; otherwise ' +
      'return needs_correction with a typed finding per unsupported requirement'
    );
  }
  if (result.status === 'needs_correction') {
    const surfacedPaths = new Set(
      options.surfacedArtifacts.map((artifact) => artifact.filename),
    );
    for (const finding of result.findings) {
      if (finding.kind !== 'artifact_repair') continue;
      const unsurfaced = finding.evidencePaths.filter(
        (path) => !surfacedPaths.has(path),
      );
      if (unsurfaced.length > 0) {
        return (
          'artifact_repair evidencePaths must name only already-surfaced files; ' +
          `unrecognized path(s): ${unsurfaced.join(', ')}. ` +
          'Cite surfaced filenames exactly as listed, or, if the supporting ' +
          'evidence is not surfaced, report a research finding instead'
        );
      }
    }
  }
  return undefined;
}

/** Build the verifier's complete opening context without touching the
 * filesystem. Deterministic checks already established the manifest facts;
 * raw bytes remain available through the bounded, no-follow inspection
 * registry. This keeps an unmanifested tree or symlink from running before
 * the verifier's cancellation and I/O bounds exist. */
export function buildVerifierOpeningInput(
  options: Pick<
    RunVerifierOptions,
    | 'taskText'
    | 'contract'
    | 'finish'
    | 'surfacedArtifacts'
    | 'settled'
    | 'outputs'
    | 'structuralFindings'
    | 'verificationHistory'
  >,
): string {
  const settled = options.settled ?? [];
  const structuralFindings = options.structuralFindings ?? [];
  const verificationHistory = options.verificationHistory ?? [];
  const columnCoverage = formatColumnCoverage(options.outputs);
  return [
    '# Original user request (authoritative)',
    options.taskText,
    '',
    '# Worker completion report (untrusted claim)',
    JSON.stringify(options.finish, null, 2),
    '',
    '# Thin task-derived contract',
    JSON.stringify(options.contract, null, 2),
    '',
    '# Surfaced manifest entries (requested_output and/or evidence only)',
    options.surfacedArtifacts.length === 0
      ? '(none)'
      : JSON.stringify(options.surfacedArtifacts, null, 2),
    '',
    '# Inspection boundary',
    'The read-only tools can inspect only the surfaced files listed above.',
    ...(settled.length === 0
      ? []
      : [
          '',
          '# Already established by code (do not re-derive or contradict)',
          'These facts were computed from the published bytes by deterministic checks.',
          ...settled.map(
            (fact) =>
              `- ${fact.outputId === undefined ? '' : `${fact.outputId}: `}${fact.statement}`,
          ),
        ]),
    ...columnCoverage,
    ...(structuralFindings.length === 0
      ? []
      : [
          '',
          '# Deterministic structural findings',
          JSON.stringify(structuralFindings, null, 2),
        ]),
    ...(verificationHistory.length === 0
      ? []
      : [
          '',
          '# Prior correction dialogue (typed records only)',
          JSON.stringify(verificationHistory, null, 2),
        ]),
  ].join('\n');
}

/** Render per-column nonblank cell counts as plain informational coverage
 * facts alongside the settled row count. Absent for outputs loaded from a
 * checkpoint written before this field existed, and never a threshold. */
function formatColumnCoverage(
  outputs: readonly OutputFact[] | undefined,
): string[] {
  const tables = (outputs ?? []).filter(
    (output): output is TableFact =>
      output.kind === 'table' && output.columnNonblankCounts !== undefined,
  );
  if (tables.length === 0) return [];
  return [
    '',
    '# Per-column nonblank coverage (informational; not a threshold or new requirement)',
    'Plain nonblank cell counts computed by code, out of the settled row count above.',
    ...tables.flatMap((table) => [
      `- ${table.artifactPath} (${table.rowCount} row(s)):`,
      ...table.columnNonblankCounts!.map(
        (count) => `  - ${count.column}: ${count.nonblankCount} nonblank`,
      ),
    ]),
  ];
}

async function persistVerifierAccounting(
  options: RunVerifierOptions,
): Promise<void> {
  if (options.afterAccounting === undefined) return;
  try {
    await options.afterAccounting();
  } catch (error) {
    throw new VerifierAccountingPersistenceError(
      `failed to persist verifier accounting: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function throwIfVerifierBudgetExceeded(budget: RunBudgetTracker): void {
  const limit = budget.exceededLimit(['worker_turns']);
  if (limit !== undefined) throw new RoleBudgetExceededError(limit);
}

function verifierResultBytes(results: readonly ToolResultBlock[]): number {
  return results.reduce((total, result) => {
    const content =
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);
    return total + Buffer.byteLength(content, 'utf8');
  }, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
