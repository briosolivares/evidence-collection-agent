import { capResult, DEFAULT_MAX_RESULT_BYTES } from './capResult.js';
import {
  deriveAccess,
  type BusyResourceRegistry,
  type ToolAccess,
  type ToolCtx,
  type ToolRegistry,
} from './registry.js';

/** One tool invocation as requested by the model (a `tool_use` block). */
export interface ToolCall {
  /** The model's tool_use id, echoed back on the result so tool_result
   * blocks can be matched to their calls. */
  id: string;
  /** Name of the tool to invoke. */
  name: string;
  /** Raw input exactly as the model supplied it — validated by the
   * pipeline, never trusted. */
  input: unknown;
}

/** Which pipeline stage rejected a call. `permission_denied` separates
 * "the human said no / nobody was there to ask" from execution failures in
 * transcripts and metrics; `timeout` separates "never came back" from
 * "failed", which are diagnosed completely differently. `resource_busy`
 * separates "never even started" from both: the call was refused before
 * `execute` ever ran, because a resource it needs was left possibly still
 * busy by an earlier abandoned call (see `BusyResourceRegistry`). */
export type ToolErrorKind =
  | 'unknown_tool'
  | 'invalid_input'
  | 'permission_denied'
  | 'execution_error'
  | 'timeout'
  | 'resource_busy';

/**
 * Wall-clock ceiling for one tool execution when the tool declares none.
 *
 * Why this lives at the pipeline and not only inside each tool: a tool that
 * never returns cannot be stopped by anything downstream of it. Every budget
 * guard — `wall_time` included — is checked AFTER a tool call completes, so
 * an execution that hangs forever hangs the entire run: no result, no
 * transcript entry, no outcome, indefinitely. Measured live on 2026-08-13, a
 * `browser_action` fill on a heavy React page stopped returning and the run
 * sat dead for ten minutes with no guard able to fire. Tools bounding their
 * own work is necessary but not sufficient — the next unbounded call
 * reintroduces the identical failure — so this is the one ceiling no tool
 * can forget to apply.
 *
 * Two minutes is deliberately generous, well past any legitimate call
 * (`browser_action`'s own worst case is 8 actions x 5s plus settle), so that
 * tripping it means something is genuinely wrong rather than merely slow.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * Wall-clock ceiling for the busy-resource gate: how long a call waits for a
 * resource an earlier, abandoned call left possibly still busy to be
 * confirmed free before failing closed with `resource_busy`.
 *
 * Reuses `DEFAULT_TOOL_TIMEOUT_MS` rather than a new arbitrary number: the
 * abandoned call was itself already given a full deadline's worth of time
 * once; giving the SAME resource one more full deadline before concluding
 * it is genuinely wedged (not merely slow) applies the same standard twice
 * rather than inventing a second one. An unbounded wait was rejected
 * deliberately — the abandoned work may never settle, and waiting forever
 * for it would silently reintroduce the exact "run hangs forever" failure
 * this whole mechanism exists to prevent, just moved one call later and
 * hidden behind a gate instead of a raw hang.
 */
export const BUSY_RESOURCE_GATE_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

/**
 * The outcome of one tool call, always model-readable: `content` is the
 * text destined for the tool_result block, and `isError` maps onto the
 * API's `is_error` flag.
 */
export type ToolCallResult =
  | { toolCallId: string; isError: false; content: string }
  | { toolCallId: string; isError: true; errorKind: ToolErrorKind; content: string };

/**
 * Execute one tool call through the standard pipeline:
 * exists-check → zod validation → permission gate → execute → normalize →
 * cap → return.
 *
 * @param registry - the tools available to this run
 * @param call     - the model-requested invocation; its `input` is untrusted
 * @param ctx      - per-run context passed through to the executor
 * @returns a structured result the model can read — never throws. On
 *   success, `content` is the executor's output (strings unchanged, other
 *   values as JSON) — unless it exceeds the tool's size cap (`maxBytes`,
 *   default DEFAULT_MAX_RESULT_BYTES), in which case the full output is
 *   offloaded to a file in the run directory and `content` is the
 *   JSON-serialized replacement (preview + path; see capResult). On
 *   failure, `isError` is true and `content` names the problem: an unknown
 *   tool (lists the tools that do exist), invalid input (includes zod's
 *   issue list, so the model sees *what* was malformed), or an executor or
 *   offload failure (includes the thrown message). `toolCallId` always
 *   echoes `call.id`.
 */
export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolCtx,
): Promise<ToolCallResult> {
  // Stage 1: the tool must exist.
  const tool = registry.get(call.name);
  if (tool === undefined) {
    return {
      toolCallId: call.id,
      isError: true,
      errorKind: 'unknown_tool',
      content:
        `Unknown tool "${call.name}". Available tools: ` +
        `${[...registry.keys()].join(', ')}.`,
    };
  }

  // Stage 2: validate the raw input against the tool's zod schema.
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    const issueLines = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(input)';
      return `- at ${path}: ${issue.message}`;
    });
    return {
      toolCallId: call.id,
      isError: true,
      errorKind: 'invalid_input',
      content: `Invalid input for tool "${call.name}":\n${issueLines.join('\n')}`,
    };
  }

  // Stage 3: the permission gate. A tool that requires user interaction
  // runs only after an interactive user allows it; the decision's
  // updatedInput (trusted, from our own UI — see PermissionDecision) then
  // replaces the validated input, which is how dialog answers reach the
  // executor. No interactive environment means fail closed: the model gets
  // a structured error and routes around it, so headless runs never hang.
  let input = parsed.data;
  if (tool.requiresUserInteraction === true) {
    if (ctx.requestPermission === undefined) {
      return {
        toolCallId: call.id,
        isError: true,
        errorKind: 'permission_denied',
        content:
          `Tool "${call.name}" requires user interaction, which this ` +
          `environment does not support. Nobody can answer, and there is no ` +
          `workaround to find: do not create an account, sign up, or enter ` +
          `credentials. Complete what you can reach, then report the blocker ` +
          `in your deliverables and finish the run.`,
      };
    }
    const decision = await ctx.requestPermission({
      toolName: call.name,
      input,
    });
    if (decision.behavior === 'deny') {
      return {
        toolCallId: call.id,
        isError: true,
        errorKind: 'permission_denied',
        content: decision.feedback,
      };
    }
    input = decision.updatedInput;
  }

  // Stage 3.5: the busy-resource gate. Derived once here — and reused by
  // withToolDeadline below to register THIS call's own abandonment, if it
  // times out — so a call that is about to touch a resource an earlier,
  // abandoned call left possibly still busy waits for it (bounded) rather
  // than racing it blind. See BusyResourceRegistry's module doc for why
  // this cannot just be "wait forever": an abandoned call may never settle.
  const access = deriveAccess(tool, input);
  if (ctx.busyRegistry !== undefined) {
    const free = await ctx.busyRegistry.waitUntilFree(access, BUSY_RESOURCE_GATE_TIMEOUT_MS);
    if (!free) {
      return {
        toolCallId: call.id,
        isError: true,
        errorKind: 'resource_busy',
        content:
          `Tool "${call.name}" was not started: a resource it needs was left possibly ` +
          `still busy by an earlier abandoned call, which has not been confirmed done ` +
          `within ${BUSY_RESOURCE_GATE_TIMEOUT_MS}ms. That earlier call may still be ` +
          `running. Observe the current state before trying again, and prefer a ` +
          `different resource or approach if this keeps happening.`,
      };
    }
  }

  // Stages 4–6: execute, normalize the output to model-readable text, then
  // cap its size — oversize output is offloaded to a file in the run
  // directory and `content` becomes a preview + path replacement, so no
  // single result can flood the context window. All three sit inside the
  // try so an unserializable output or a failed offload is reported as an
  // execution error rather than crashing the pipeline.
  let content: string;
  try {
    const normalized = normalizeOutput(
      await withToolDeadline(
        tool.name,
        tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        () => tool.execute(input, ctx),
        ctx.busyRegistry,
        access,
      ),
    );
    const capped = capResult(
      ctx.runDir,
      tool.name,
      normalized,
      tool.maxBytes ?? DEFAULT_MAX_RESULT_BYTES,
    );
    // An offloaded replacement is structured output like any other: the
    // model receives it JSON-serialized.
    content = typeof capped === 'string' ? capped : JSON.stringify(capped);
  } catch (thrown) {
    if (thrown instanceof ToolTimeoutError) {
      return {
        toolCallId: call.id,
        isError: true,
        errorKind: 'timeout',
        content:
          `Tool "${call.name}" did not return within ${thrown.timeoutMs}ms and was ` +
          `abandoned. Whatever it had already done may have taken effect, so treat ` +
          `the result as unknown rather than as "nothing happened": observe the ` +
          `current state before acting again, and prefer a different approach — the ` +
          `same call may well hang the same way.`,
      };
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      toolCallId: call.id,
      isError: true,
      errorKind: 'execution_error',
      content: `Tool "${call.name}" failed: ${message}`,
    };
  }

  // Stage 7: return.
  return { toolCallId: call.id, isError: false, content };
}

/** Raised when a tool execution outlives its deadline. Distinct from any
 * error a tool itself throws, because the two mean different things: a
 * throw means the work finished badly, this means it never finished. */
export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run one execution under a wall-clock ceiling.
 *
 * The abandoned work is NOT cancelled — it cannot be. A wedged renderer or a
 * socket that never answers keeps its promise pending forever, and there is
 * no way to reach in and stop it. What this buys is that the RUN continues:
 * the call becomes a failed result the model can read and route around, and
 * the loop's budget guards get to run again.
 *
 * On timeout, `access`'s keys are registered with `busyRegistry` (when one
 * is given) as possibly still busy until `started` itself eventually
 * settles — see `BusyResourceRegistry`'s module doc for why a later call
 * touching the same keys needs to know that, rather than treating this
 * call's timeout as proof the resource is free. Without a registry, the
 * abandoned promise's eventual rejection is swallowed the old way: nobody is
 * listening for it any more, and an unhandled rejection must not take the
 * process down long after the call it belonged to was reported.
 *
 * A non-finite `timeoutMs` opts out entirely, for a tool whose waiting is
 * legitimately unbounded. Note that the human wait in `ask_user_question`
 * needs no such opt-out: it happens in the permission gate, before execute,
 * which this never wraps.
 */
async function withToolDeadline<T>(
  toolName: string,
  timeoutMs: number,
  work: () => Promise<T> | T,
  busyRegistry: BusyResourceRegistry | undefined,
  access: ToolAccess,
): Promise<T> {
  if (!Number.isFinite(timeoutMs)) return await work();
  const started = Promise.resolve(work());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      if (busyRegistry !== undefined) {
        busyRegistry.markAbandoned(access, started);
      } else {
        void started.catch(() => undefined);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize an executor's raw output to model-readable text: strings pass
 * through unchanged, `undefined` (a pure side-effect tool) becomes the
 * empty string, and everything else is JSON-serialized. */
function normalizeOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  return JSON.stringify(output);
}
