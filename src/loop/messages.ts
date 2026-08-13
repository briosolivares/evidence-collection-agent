// Minimal structural types mirroring the Anthropic Messages API: the
// conversation messages the loop assembles and the response shape
// `deps.callModel` must return. Field names deliberately keep the API's
// snake_case so a real client (T9) can hand its assembled responses to the
// loop without renaming anything. No SDK import — scripted fakes and the
// real streaming client satisfy the same contract and drop into the loop
// interchangeably.

/** A block of prose, in either an assistant or a user message. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** The model's request to invoke one tool. */
export interface ToolUseBlock {
  type: 'tool_use';
  /** Response-unique id; the matching tool_result echoes it back. */
  id: string;
  /** Name of the tool to invoke. */
  name: string;
  /** Raw input exactly as the model supplied it — validated by the tool
   * pipeline, never trusted. */
  input: unknown;
}

/** An image carried inside a tool_result block, mirroring the API's base64
 * image source shape. Produced only by the judge's screenshot reads (see
 * harness/judge.ts) — every worker-loop tool returns strings. */
export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    /** The image's MIME type; the judge derives it from the file
     * extension. */
    media_type: 'image/png' | 'image/jpeg';
    /** The image bytes, base64-encoded. */
    data: string;
  };
}

/** The harness's answer to one tool_use block, carried in the next user
 * message. */
export interface ToolResultBlock {
  type: 'tool_result';
  /** The `id` of the tool_use block this result answers. */
  tool_use_id: string;
  /** The model-readable result: plain text (already bounded by the
   * pipeline's size cap) for every worker tool, or a block array when the
   * result carries an image (the judge's screenshot reads — see
   * harness/judge.ts). The API accepts both shapes verbatim. */
  content: string | Array<TextBlock | ImageBlock>;
  /** Present and true iff the call failed; the model reads `content` to
   * learn what went wrong. Omitted on success. */
  is_error?: boolean;
}

/** What an assistant message may contain. */
export type AssistantContentBlock = TextBlock | ToolUseBlock;

/** What a user message may contain: the task text, or tool results. */
export type UserContentBlock = TextBlock | ToolResultBlock;

/** One user-role message in the conversation. */
export interface UserMessage {
  role: 'user';
  content: UserContentBlock[];
}

/** One assistant-role message in the conversation. */
export interface AssistantMessage {
  role: 'assistant';
  content: AssistantContentBlock[];
}

/** One conversation message, as sent to the model. */
export type Message = UserMessage | AssistantMessage;

/** Token accounting reported on each model response. */
export interface Usage {
  /** Uncached input tokens processed for this response. */
  input_tokens: number;
  /** Output tokens generated for this response. */
  output_tokens: number;
  /** Input tokens served from the prompt cache, when the client reports
   * them (absent or null otherwise). Nonzero from turn 2 onward is the
   * design's explicit check that the stable prompt prefix is working. */
  cache_read_input_tokens?: number | null;
  /** Input tokens written to the prompt cache by this response, when the
   * client reports them (absent or null otherwise). With the moving
   * conversation breakpoint every turn extends the cache, so nonzero here
   * on every turn is the check that the extension is being written. */
  cache_creation_input_tokens?: number | null;
}

/** One complete model response. */
export interface ModelResponse {
  /** The response's content blocks, in order. */
  content: AssistantContentBlock[];
  /**
   * The API's label for why generation stopped (e.g. "end_turn",
   * "tool_use"). It exists here so the real client can record it verbatim,
   * but the loop deliberately never consults it: whether the run continues
   * is decided by inspecting `content` for tool_use blocks. Content is the
   * ground truth — deciding from this label would let a mislabeled or
   * truncated response silently end, or wrongly extend, a run.
   */
  stop_reason: string | null;
  /** Token accounting for this response; feeds the token-budget guard and
   * the run's metrics. */
  usage: Usage;
}

/**
 * The model call the loop depends on (`deps.callModel`).
 *
 * @param messages - the full conversation so far, first message = the task;
 *   implementations must not mutate it
 * @returns the model's complete response for this turn
 */
export type CallModel = (messages: readonly Message[]) => Promise<ModelResponse>;
