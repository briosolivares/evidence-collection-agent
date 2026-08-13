// The API message view: a per-turn transformation applied to the loop's
// conversation right before it is sent to the model. The loop's own state
// and the on-disk transcript's tool_result events keep every result in
// full; only what the model sees each turn is reshaped here.
//
// Why it exists: inspect_page results are the conversation's whales — a
// full-page semantic outline every observation — and a deep run drags
// dozens of stale ones along forever. At 170k+ tokens of context, long
// tool-input generation stalls against a ~60s server watchdog and the
// stream dies (see docs/reports/2026-08-12-full-suite-first-run.md,
// failure mode 1). Collapsing all but the most recent page snapshots keeps
// deep runs below that regime; the system prompt teaches the model that
// lasting facts belong in scratch//artifacts/ files and refs come from its
// latest inspections.

import type { Message, ToolResultBlock } from './messages.js';

/**
 * Registry name of the tool whose results the view elides. A literal, not
 * an import from the tools package — the loop stays free of tool
 * implementations; contextView.test.ts pins this to the real tool's name.
 */
export const INSPECT_TOOL_NAME = 'inspect_page';

/**
 * How many of the most recent successful inspect_page results survive
 * intact. Two, per the elision plan: the latest inspection carries the
 * live refs, and one predecessor covers compare-against-previous-page
 * reasoning.
 */
export const KEPT_INSPECT_RESULTS = 2;

/** Opening line of every stub — also the marker tests and humans can grep
 * a transcript for. */
export const ELISION_MARKER = '[Stale inspect_page result elided — only the two most recent page inspections stay in the conversation.]';

/** Closing guidance of every stub: the recovery path is re-inspection. */
const REINSPECT_LINE =
  'Its content and refs are gone from this view. Run inspect_page again if this page is needed; durable facts belong in scratch/ or artifacts/ files.';

/**
 * Whether a tool_result block is one of this view's stubs. Content-based
 * (the stub's fixed opening line), so callers outside the loop — the cache
 * breakpoint placement in callModel — can recognize stubs without any
 * plumbing. A tool result that merely *contains* the marker mid-content
 * (say, a read_file of a saved transcript) is not mistaken for one; a
 * false positive would misplace a cache marker, never corrupt a request.
 */
export function isElisionStub(block: { type: string; content?: unknown }): boolean {
  return (
    block.type === 'tool_result' &&
    typeof block.content === 'string' &&
    block.content.startsWith(ELISION_MARKER)
  );
}

/**
 * Build the API message view: replace every successful inspect_page
 * tool_result except the last KEPT_INSPECT_RESULTS with a short stub
 * (URL/title when recoverable, plus re-inspect guidance).
 *
 * Contract:
 * - Pure and non-mutating: `messages`, its messages, and their blocks are
 *   never modified. Untouched messages are returned by identity, so a view
 *   is cheap when nothing (or little) changes.
 * - Deterministic: the stub for a given result depends only on that
 *   result's content, so once a result goes stale its stubbed message is
 *   byte-identical in every later view — the prompt-cache prefix survives;
 *   each new inspection invalidates the cache only from the message of the
 *   result it displaces.
 * - Structure-preserving: a stub keeps its block's tool_use_id, position,
 *   and type; only `content` is replaced. The API still sees a well-formed
 *   tool_use/tool_result pairing.
 * - Failed inspections (is_error) are never stubbed and never counted
 *   toward the kept window: they are small, they carry what went wrong,
 *   and eliding one would hide the error while a stale success elsewhere
 *   survived.
 *
 * @param messages - the loop's full conversation for this turn
 * @returns the conversation to send to the model: `messages` itself when
 *   nothing needs eliding, otherwise a new array sharing every untouched
 *   message by identity
 */
export function elideStaleInspectResults(messages: readonly Message[]): readonly Message[] {
  // Which tool_use ids belong to inspect_page. Results are matched through
  // the id, never by sniffing content — a read_file of a page dump must
  // not be mistaken for an inspection.
  const inspectIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === INSPECT_TOOL_NAME) {
        inspectIds.add(block.id);
      }
    }
  }
  if (inspectIds.size <= KEPT_INSPECT_RESULTS) return messages;

  // Locate every elidable result in conversation order; all but the last
  // KEPT_INSPECT_RESULTS go stale.
  const found: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    message.content.forEach((block, blockIndex) => {
      if (
        block.type === 'tool_result' &&
        inspectIds.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        found.push({ messageIndex, blockIndex });
      }
    });
  });
  const stale = found.slice(0, Math.max(0, found.length - KEPT_INSPECT_RESULTS));
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
 * header when it can be recovered, and the re-inspect guidance. */
function stubResultBlock(block: ToolResultBlock): ToolResultBlock {
  // inspect_page results are always plain text; the string check is for the
  // type system (ToolResultBlock.content also admits image-carrying arrays,
  // which only the judge produces and which are never elidable).
  const header = typeof block.content === 'string' ? extractPageHeader(block.content) : undefined;
  const content = [ELISION_MARKER, ...(header === undefined ? [] : [header]), REINSPECT_LINE].join(
    '\n',
  );
  return { ...block, content };
}

/**
 * Recover the `URL: …\nTitle: …` header an inspect_page result opens with
 * (see formatPageHeader). Results that were offloaded by a size cap are the
 * JSON replacement object whose `preview` opens with the same header, so
 * the preview is consulted when the content parses as one. Returns
 * undefined when no header is recognizable — the stub then simply omits it.
 */
function extractPageHeader(content: string): string | undefined {
  let source = content;
  if (content.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(content);
      const preview = (parsed as { preview?: unknown }).preview;
      if (typeof preview === 'string') source = preview;
    } catch {
      // Not the offload replacement — read the content as-is.
    }
  }
  const [urlLine, titleLine] = source.split('\n', 2);
  if (urlLine?.startsWith('URL: ') === true && titleLine?.startsWith('Title: ') === true) {
    return `${urlLine}\n${titleLine}`;
  }
  return undefined;
}
