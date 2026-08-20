import type { Message, ToolResultBlock, ToolUseBlock } from '../../model/messages.js';
import {
  COLLAPSED_BROWSER_RESULT_MARKER,
  COLLAPSED_CAPTURE_SCREENSHOT_RESULT_MARKER,
} from '../../model/callModel.js';
import { CAPTURE_SCREENSHOT_TOOL_NAME } from '../../tools/captureScreenshot/captureScreenshot.js';

/** Text-heavy browser results retain two windows; visual captures are shown once. */
export const BROWSER_EXECUTE_TOOL_NAME = 'browser_execute' as const;

/** The newest two successful browser results retain their complete content. */
export const KEPT_BROWSER_EXECUTE_RESULTS = 2;

const RECOVERY_GUIDANCE =
  'Large value/stdout/stderr/file details were removed from this request view. ' +
  'Run browser_execute again if live page detail is needed; keep durable facts in scratch/workspace files.';

const CAPTURE_RECOVERY_GUIDANCE =
  'The pixels were shown once and removed from later request views. ' +
  'Call capture_screenshot again to inspect the current live viewport.';

interface BrowserCallIdentity {
  toolUseId: string;
  requestedPageId?: string;
}

interface BrowserResultSummary {
  status?: string;
  pages?: Array<{
    pageId: string;
    url?: string;
    active?: boolean;
  }>;
}

/**
 * Build the model-request view without changing durable conversation
 * history. Every successful `browser_execute` result except the newest two
 * becomes a short, deterministic identity/status/page stub. Failed pipeline
 * results remain full and do not consume either retained slot.
 *
 * Untouched messages and blocks are returned by identity. A stub depends only
 * on its original call and result, so it remains byte-identical on every later
 * request and is safe as a moving prompt-cache frontier.
 */
export function buildContextView(messages: readonly Message[]): readonly Message[] {
  const browserCalls = collectBrowserCalls(messages);
  const captureCalls = collectCaptureCalls(messages);
  if (browserCalls.size === 0 && captureCalls.size === 0) return messages;

  const successfulResults: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    message.content.forEach((block, blockIndex) => {
      if (
        block.type === 'tool_result' &&
        block.is_error !== true &&
        browserCalls.has(block.tool_use_id)
      ) {
        successfulResults.push({ messageIndex, blockIndex });
      }
    });
  });

  const staleBrowserResults = successfulResults.slice(
    0,
    Math.max(0, successfulResults.length - KEPT_BROWSER_EXECUTE_RESULTS),
  );

  const staleCaptureResults: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user' || messageIndex === messages.length - 1) return;
    message.content.forEach((block, blockIndex) => {
      if (
        block.type === 'tool_result' &&
        block.is_error !== true &&
        captureCalls.has(block.tool_use_id)
      ) {
        staleCaptureResults.push({ messageIndex, blockIndex });
      }
    });
  });

  const stale = [...staleBrowserResults, ...staleCaptureResults];
  if (stale.length === 0) return messages;

  const staleByMessage = new Map<number, Set<number>>();
  for (const { messageIndex, blockIndex } of stale) {
    const indexes = staleByMessage.get(messageIndex) ?? new Set<number>();
    indexes.add(blockIndex);
    staleByMessage.set(messageIndex, indexes);
  }

  return messages.map((message, messageIndex) => {
    const staleIndexes = staleByMessage.get(messageIndex);
    if (message.role !== 'user' || staleIndexes === undefined) return message;

    return {
      role: 'user',
      content: message.content.map((block, blockIndex) => {
        if (!staleIndexes.has(blockIndex) || block.type !== 'tool_result') return block;
        const browserCall = browserCalls.get(block.tool_use_id);
        if (browserCall !== undefined) return stubBrowserResult(block, browserCall);
        return stubCaptureResult(block, captureCalls.get(block.tool_use_id)!);
      }),
    };
  });
}

function collectCaptureCalls(messages: readonly Message[]): Map<string, BrowserCallIdentity> {
  const calls = new Map<string, BrowserCallIdentity>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== CAPTURE_SCREENSHOT_TOOL_NAME) continue;
      calls.set(block.id, callIdentity(block));
    }
  }
  return calls;
}

function collectBrowserCalls(messages: readonly Message[]): Map<string, BrowserCallIdentity> {
  const calls = new Map<string, BrowserCallIdentity>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== BROWSER_EXECUTE_TOOL_NAME) {
        continue;
      }
      calls.set(block.id, callIdentity(block));
    }
  }
  return calls;
}

function callIdentity(call: ToolUseBlock): BrowserCallIdentity {
  const pageId =
    isRecord(call.input) && typeof call.input.page_id === 'string' ? call.input.page_id : undefined;
  return {
    toolUseId: call.id,
    ...(pageId === undefined ? {} : { requestedPageId: pageId }),
  };
}

function stubBrowserResult(block: ToolResultBlock, identity: BrowserCallIdentity): ToolResultBlock {
  const summary =
    typeof block.content === 'string' ? recoverBrowserResultSummary(block.content) : {};
  const lines = [
    COLLAPSED_BROWSER_RESULT_MARKER,
    `Identity: ${JSON.stringify({
      tool_use_id: identity.toolUseId,
      ...(identity.requestedPageId === undefined
        ? { requested_page: 'active task page' }
        : { requested_page_id: identity.requestedPageId }),
    })}`,
    ...(summary.status === undefined ? [] : [`Status: ${JSON.stringify(summary.status)}`]),
    ...(summary.pages === undefined ? [] : [`Pages: ${JSON.stringify(summary.pages)}`]),
    RECOVERY_GUIDANCE,
  ];
  return { ...block, content: lines.join('\n') };
}

function stubCaptureResult(block: ToolResultBlock, identity: BrowserCallIdentity): ToolResultBlock {
  const metadata =
    typeof block.content === 'string'
      ? block.content
      : block.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
  return {
    ...block,
    content: [
      COLLAPSED_CAPTURE_SCREENSHOT_RESULT_MARKER,
      `Identity: ${JSON.stringify({
        tool_use_id: identity.toolUseId,
        ...(identity.requestedPageId === undefined
          ? { requested_page: 'active task page' }
          : { requested_page_id: identity.requestedPageId }),
      })}`,
      ...(metadata.length === 0 ? [] : [`Metadata: ${metadata}`]),
      CAPTURE_RECOVERY_GUIDANCE,
    ].join('\n'),
  };
}

/**
 * Results normally parse in full. A per-result offload envelope instead
 * holds a possibly truncated `preview`, so status and a complete pages array
 * are also recovered from that prefix when possible.
 */
function recoverBrowserResultSummary(content: string): BrowserResultSummary {
  const parsed = parseJson(content);
  if (!isRecord(parsed)) return {};

  const direct = summaryFromRecord(parsed);
  if (direct.status !== undefined || direct.pages !== undefined) return direct;

  const preview = parsed.preview;
  if (typeof preview !== 'string') return {};
  const previewParsed = parseJson(preview);
  if (isRecord(previewParsed)) return summaryFromRecord(previewParsed);

  return {
    ...(extractJsonStringField(preview, 'status') === undefined
      ? {}
      : { status: extractJsonStringField(preview, 'status') }),
    ...(extractJsonArrayField(preview, 'pages') === undefined
      ? {}
      : { pages: normalizePages(extractJsonArrayField(preview, 'pages')) }),
  };
}

function summaryFromRecord(value: Record<string, unknown>): BrowserResultSummary {
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(Array.isArray(value.pages) ? { pages: normalizePages(value.pages) } : {}),
  };
}

function normalizePages(value: unknown): BrowserResultSummary['pages'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages: NonNullable<BrowserResultSummary['pages']> = [];
  for (const page of value) {
    if (!isRecord(page) || typeof page.pageId !== 'string') continue;
    pages.push({
      pageId: page.pageId,
      ...(typeof page.url === 'string' ? { url: page.url } : {}),
      ...(typeof page.active === 'boolean' ? { active: page.active } : {}),
    });
  }
  return pages;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJsonStringField(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  if (match?.[1] === undefined) return undefined;
  return parseJson(`"${match[1]}"`) as string | undefined;
}

/** Extract a complete JSON array from a prefix, respecting strings/escapes. */
function extractJsonArrayField(text: string, field: string): unknown[] | undefined {
  const marker = `"${field}":[`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return undefined;
  const start = markerIndex + marker.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        const parsed = parseJson(text.slice(start, index + 1));
        return Array.isArray(parsed) ? parsed : undefined;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
