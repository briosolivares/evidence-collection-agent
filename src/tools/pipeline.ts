import { capResult, DEFAULT_MAX_RESULT_BYTES } from './capResult.js';
import type { ToolCtx, ToolRegistry } from './registry.js';

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

/** Which pipeline stage rejected a call. */
export type ToolErrorKind = 'unknown_tool' | 'invalid_input' | 'execution_error';

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
 * exists-check → zod validation → execute → normalize → cap → return.
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

  // Stages 3–5: execute, normalize the output to model-readable text, then
  // cap its size — oversize output is offloaded to a file in the run
  // directory and `content` becomes a preview + path replacement, so no
  // single result can flood the context window. All three sit inside the
  // try so an unserializable output or a failed offload is reported as an
  // execution error rather than crashing the pipeline.
  let content: string;
  try {
    const normalized = normalizeOutput(await tool.execute(parsed.data, ctx));
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
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      toolCallId: call.id,
      isError: true,
      errorKind: 'execution_error',
      content: `Tool "${call.name}" failed: ${message}`,
    };
  }

  // Stage 6: return.
  return { toolCallId: call.id, isError: false, content };
}

/** Normalize an executor's raw output to model-readable text: strings pass
 * through unchanged, `undefined` (a pure side-effect tool) becomes the
 * empty string, and everything else is JSON-serialized. */
function normalizeOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  return JSON.stringify(output);
}
