// The API message view: a per-turn transformation applied to the loop's
// conversation right before it is sent to the model. The loop's own state
// and the on-disk transcript's tool_result events keep every result in
// full; only what the model sees each turn is reshaped here.
//
// Why it exists: observe results are the conversation's whales — a
// full-page interactive outline (plus text/changes) every observation — and
// a deep run drags dozens of stale ones along forever. At 170k+ tokens of
// context, long tool-input generation stalls against a ~60s server watchdog
// and the stream dies (see docs/reports/2026-08-12-full-suite-first-run.md,
// failure mode 1, from the era when the page-observation tool was
// inspect_page — the failure mode is identical under observe). Collapsing
// all but the most recent page snapshots keeps deep runs below that regime;
// the system prompt teaches the model that lasting facts belong in
// scratch/ or artifacts/ files and refs come from its latest observations.

import type { Message, ToolResultBlock } from './messages.js';

/**
 * Registry name of the tool whose results the view collapses. A literal, not
 * an import from the tools package — the loop stays free of tool
 * implementations; contextView.test.ts pins this to the real tool's name.
 * Was `inspect_page` until the V2 tool cutover retired it in favor of
 * `observe` (src/tools/observe/observe.ts); this constant tracks whichever
 * tool is the live page-observation surface.
 */
export const OBSERVE_TOOL_NAME = 'observe';

/**
 * How many of the most recent successful observe results survive intact.
 * Two, per the collapse plan: the latest observation carries the live refs,
 * and one predecessor covers compare-against-previous-page reasoning.
 */
export const KEPT_OBSERVE_RESULTS = 2;

/** Opening line of every stub — also the marker tests and humans can grep
 * a transcript for. */
export const COLLAPSED_MARKER = '[Older observation collapsed — only the two most recent page observations stay in the conversation.]';

/** Closing guidance of every stub: the recovery path is re-observing. */
const REINSPECT_LINE =
  'Its content and refs are gone from this view. Run observe again if this page is needed; durable facts belong in scratch/ or artifacts/ files.';

/**
 * Whether a tool_result block is one of this view's stubs. Content-based
 * (the stub's fixed opening line), so callers outside the loop — the cache
 * breakpoint placement in callModel — can recognize stubs without any
 * plumbing. A tool result that merely *contains* the marker mid-content
 * (say, a read_file of a saved transcript) is not mistaken for one; a
 * false positive would misplace a cache marker, never corrupt a request.
 */
export function isCollapsedStub(block: { type: string; content?: unknown }): boolean {
  return (
    block.type === 'tool_result' &&
    typeof block.content === 'string' &&
    block.content.startsWith(COLLAPSED_MARKER)
  );
}

/**
 * Build the API message view: replace every successful observe tool_result
 * except the last KEPT_OBSERVE_RESULTS with a short stub (URL/title when
 * recoverable, plus re-observe guidance).
 *
 * Contract:
 * - Pure and non-mutating: `messages`, its messages, and their blocks are
 *   never modified. Untouched messages are returned by identity, so a view
 *   is cheap when nothing (or little) changes.
 * - Deterministic: the stub for a given result depends only on that
 *   result's content, so once a result goes stale its stubbed message is
 *   byte-identical in every later view — the prompt-cache prefix survives;
 *   each new observation invalidates the cache only from the message of the
 *   result it displaces.
 * - Structure-preserving: a stub keeps its block's tool_use_id, position,
 *   and type; only `content` is replaced. The API still sees a well-formed
 *   tool_use/tool_result pairing.
 * - Failed observations (is_error) are never stubbed and never counted
 *   toward the kept window: they are small, they carry what went wrong,
 *   and collapsing one would hide the error while a stale success elsewhere
 *   survived.
 *
 * @param messages - the loop's full conversation for this turn
 * @returns the conversation to send to the model: `messages` itself when
 *   nothing needs collapsing, otherwise a new array sharing every untouched
 *   message by identity
 */
export function collapseStaleObservations(messages: readonly Message[]): readonly Message[] {
  // Which tool_use ids belong to observe. Results are matched through the
  // id, never by sniffing content — a read_file of a page dump must not be
  // mistaken for an observation.
  const observeIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === OBSERVE_TOOL_NAME) {
        observeIds.add(block.id);
      }
    }
  }
  if (observeIds.size <= KEPT_OBSERVE_RESULTS) return messages;

  // Locate every collapsible result in conversation order; all but the last
  // KEPT_OBSERVE_RESULTS go stale.
  const found: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    message.content.forEach((block, blockIndex) => {
      if (
        block.type === 'tool_result' &&
        observeIds.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        found.push({ messageIndex, blockIndex });
      }
    });
  });
  const stale = found.slice(0, Math.max(0, found.length - KEPT_OBSERVE_RESULTS));
  if (stale.length === 0) return messages;

  const staleBlocksByMessage = new Map<number, Set<number>>();
  for (const { messageIndex, blockIndex } of stale) {
    const set = staleBlocksByMessage.get(messageIndex) ?? new Set<number>();
    set.add(blockIndex);
    staleBlocksByMessage.set(messageIndex, set);
  }

  return messages.map((message, messageIndex) => {
    const staleBlocks = staleBlocksByMessage.get(messageIndex);
    if (staleBlocks === undefined || message.role !== 'user') return message;
    return {
      role: message.role,
      content: message.content.map((block, blockIndex) =>
        staleBlocks.has(blockIndex) && block.type === 'tool_result'
          ? stubResultBlock(block)
          : block,
      ),
    };
  });
}

/** The stub that replaces a stale result: marker line, the page's URL/title
 * header when it can be recovered, and the re-observe guidance. */
function stubResultBlock(block: ToolResultBlock): ToolResultBlock {
  // observe results are always structured JSON text (a BrowserObservation,
  // or the {preview, offloadedTo, note} offload envelope); the string check
  // is for the type system (ToolResultBlock.content also admits
  // image-carrying arrays, which only the judge produces and which are
  // never collapsible).
  const header = typeof block.content === 'string' ? extractPageHeader(block.content) : undefined;
  const content = [COLLAPSED_MARKER, ...(header === undefined ? [] : [header]), REINSPECT_LINE].join(
    '\n',
  );
  return { ...block, content };
}

/**
 * Recover a `URL: …\nTitle: …` header from an observe result's page
 * identity (`BrowserObservation.page.url` / `.title` — see
 * src/browser/browserState.ts). A normal result is
 * `JSON.stringify(BrowserObservation)`, which parses cleanly and exposes
 * those fields directly. A result oversized enough to be offloaded (see
 * capResult.ts) is instead `{preview, offloadedTo, note}`, where `preview`
 * is a byte-truncated prefix of that same JSON — `page` is the
 * observation's first key, so url/title are ordinarily still inside the
 * preview, but the prefix can be cut mid-string, so it is read with a
 * tolerant field-level scan rather than a nested `JSON.parse`. Returns
 * undefined when no header is recognizable — the stub then simply omits it.
 */
function extractPageHeader(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const page = (parsed as { page?: unknown }).page;
  if (page !== null && typeof page === 'object') {
    const url = (page as { url?: unknown }).url;
    const title = (page as { title?: unknown }).title;
    if (typeof url === 'string' && typeof title === 'string') {
      return `URL: ${url}\nTitle: ${title}`;
    }
  }
  const preview = (parsed as { preview?: unknown }).preview;
  if (typeof preview === 'string') {
    const url = extractJsonStringField(preview, 'url');
    const title = extractJsonStringField(preview, 'title');
    if (url !== undefined && title !== undefined) {
      return `URL: ${url}\nTitle: ${title}`;
    }
  }
  return undefined;
}

/**
 * Pull a `"field":"value"` JSON string field's decoded value out of text that
 * may be truncated mid-object (an offload preview), without requiring the
 * whole text to parse as JSON.
 *
 * Takes the FIRST match, which is the page's own field only because `page` is
 * the first key an observation serializes. That assumption is safe to make
 * here and nowhere else: the value feeds an optional stub header, so a wrong
 * or missing match costs a line of context detail and can never suppress the
 * collapse itself.
 */
function extractJsonStringField(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

// --- T15: cache-safe compaction and frozen previews --------------------------

/**
 * Freeze a tool result's model-visible text the first time it is shown.
 *
 * Replaying history must reproduce byte-identical requests, or every replay
 * breaks the prompt cache it was supposed to reuse. The offload/inline
 * decision and the exact preview string are therefore decided once and
 * remembered, rather than recomputed from the underlying content — which
 * could legitimately differ later (a file grew, a cap changed) and silently
 * rewrite history.
 *
 * @param frozen - the run's memo, keyed by tool-call id; mutated in place
 * @param toolCallId - the call whose result is being shown
 * @param compute - produces the text the FIRST time this id is seen
 * @returns the frozen text — `compute`'s result on first call, the identical
 *   string on every call after
 */
export function freezeToolResultPreview(
  frozen: Map<string, string>,
  toolCallId: string,
  compute: () => string,
): string {
  const existing = frozen.get(toolCallId);
  if (existing !== undefined) return existing;
  const computed = compute();
  frozen.set(toolCallId, computed);
  return computed;
}

/** Where a compaction boundary was placed, and what it replaced. */
export interface CompactionResult {
  /** The messages to send, with everything before the boundary summarized. */
  messages: readonly Message[];
  /** True when a boundary was actually inserted. */
  compacted: boolean;
  /** How many messages were replaced by the summary. */
  replacedCount: number;
}

/**
 * Compact the conversation at an explicit boundary, turning everything before
 * it into one summary message that becomes the new stable cached prefix.
 *
 * Two rules make this safe:
 *
 *  1. Compaction happens at a BOUNDARY, not continuously. A rolling window
 *     would change the prefix on every turn and destroy the cache it was
 *     meant to protect; one boundary produces one new prefix that many
 *     subsequent turns can all reuse.
 *  2. The summary must carry forward the state a worker cannot re-derive —
 *     the caller supplies it (normally serializeAgentContext's output, which
 *     always includes the current contract, output state, evidence index, and
 *     unresolved repeated failures). Compaction therefore never removes those
 *     facts; it removes the raw observations they were derived from.
 *
 * @param messages - the full conversation
 * @param keepRecent - how many trailing messages stay verbatim; >= 1
 * @param stateSummary - the text carried forward in place of what is dropped
 * @returns the compacted view, or the input untouched when there is nothing
 *   worth compacting (fewer messages than the window, or nothing but the
 *   opening task before it)
 */
export function compactAtBoundary(
  messages: readonly Message[],
  keepRecent: number,
  stateSummary: string,
): CompactionResult {
  if (!Number.isInteger(keepRecent) || keepRecent < 1) {
    throw new Error(`keepRecent must be an integer >= 1, got ${keepRecent}`);
  }
  // The opening task message is never compacted away: it is the run's
  // authority on what was actually asked, and every later check is against
  // it. So compaction needs at least one message after it to be worth doing.
  const boundary = messages.length - keepRecent;
  if (boundary <= 1) {
    return { messages, compacted: false, replacedCount: 0 };
  }

  const opening = messages[0]!;
  const recent = messages.slice(boundary);
  // A tool_result block must directly follow its tool_use, so a boundary that
  // would orphan one is moved back to include the assistant message that
  // issued it. Cutting mid-pair produces an API error, not a smaller prompt.
  const adjusted = recent[0]?.role === 'user' && hasToolResult(recent[0]) ? boundary - 1 : boundary;
  const safeRecent = messages.slice(adjusted);

  const summaryMessage: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `[Earlier turns compacted. ${adjusted - 1} message(s) of raw observations were ` +
          'replaced by the current state below; nothing here is a new instruction.]\n\n' +
          stateSummary,
      },
    ],
  };

  return {
    messages: [opening, summaryMessage, ...safeRecent],
    compacted: true,
    replacedCount: adjusted - 1,
  };
}

/** Whether a message carries any tool_result block. */
function hasToolResult(message: Message): boolean {
  return message.content.some((block) => block.type === 'tool_result');
}
