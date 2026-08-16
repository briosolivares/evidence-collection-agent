// Pure derivation of semantic transcript lines from tool calls (design
// "Semantic line derivation" table): tool activity reads as what the
// agent is doing (`Opening sec.gov/…`), never raw JSON. Tools likely to
// publish get the stronger ◆ treatment while in flight (R5) — the
// finalized item's activity/evidence classification is decided by actual
// artifact publishes in the reducer, not here.
//
// The cases below must track the live tool set (src/tools/index.ts). They
// used to name the retired atomic browser tools, which meant every tool the
// agent actually calls fell through to `default` and rendered as a bare
// registry name — the transcript degraded to exactly the raw-name output this
// module exists to avoid.

import { shortenUrl, truncate } from '../format.js';

/** Maximum rendered length for interpolated fragments. */
const TEXT_MAX = 40;
const LINE_URL_MAX = 44;

/** One derived line: its text and whether it likely publishes evidence
 * (a styling hint for the pending line, not a classification). */
export interface SemanticLine {
  line: string;
  isEvidence: boolean;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(input: unknown, key: string): unknown[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : undefined;
}

function has(input: unknown, key: string): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>)[key] !== undefined
  );
}

/** `browser_action` carries a sequence of ops; name the first one, since a
 * sequence's whole point is that it starts somewhere specific. */
function describeActions(input: unknown): string {
  const actions = list(input, 'actions');
  const first = actions?.[0];
  const op = typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>).op
    : undefined;
  const suffix = actions === undefined || actions.length <= 1 ? '' : ` (+${actions.length - 1})`;
  if (op === 'navigate') {
    const url = field(first, 'url');
    return url === undefined ? `Opening a page${suffix}` : `Opening ${shortenUrl(url, LINE_URL_MAX)}${suffix}`;
  }
  // The element ref is worth showing: it is how a reader ties the line to the
  // observation it came from, and to the failure when a stale ref is rejected.
  const target = field(first, 'target');
  if (op === 'click') {
    return target === undefined ? `Clicking${suffix}` : `Clicking ${target}${suffix}`;
  }
  // 'fill', not 'type' — see browserActionSchema. This branch read `op ===
  // 'type'` at first, which never matched, so every fill rendered as the
  // generic step count; the test made the same wrong assumption and so passed
  // while checking nothing. Any op added there needs a line here or it falls
  // through to the count.
  if (op === 'fill') {
    const text = field(first, 'text');
    return text === undefined ? `Typing${suffix}` : `Typing "${truncate(text, TEXT_MAX)}"${suffix}`;
  }
  if (op === 'press') {
    const key = field(first, 'key');
    return key === undefined ? `Pressing a key${suffix}` : `Pressing ${key}${suffix}`;
  }
  if (op === 'select') return `Choosing an option${suffix}`;
  if (op === 'check') return `Toggling a checkbox${suffix}`;
  if (op === 'hover') {
    return target === undefined ? `Hovering${suffix}` : `Hovering ${target}${suffix}`;
  }
  if (op === 'upload') return `Attaching a file${suffix}`;
  if (op === 'scroll') return `Scrolling${suffix}`;
  if (actions === undefined) return 'Acting on the page';
  return `Running ${actions.length} browser step${actions.length === 1 ? '' : 's'}`;
}

/** How one `update_table` call reads, given which sections it carries. A call
 * may carry several; filling rows is the headline when it does. */
function describeTableUpdate(input: unknown): string {
  const outputId = field(input, 'outputId');
  const target = outputId === undefined ? 'a table' : truncate(outputId, TEXT_MAX);
  const upsert = (input as Record<string, unknown> | null | undefined)?.upsert;
  const rows = list(upsert, 'rows')?.length;
  if (rows !== undefined) {
    return `Filling ${target}: ${rows} row${rows === 1 ? '' : 's'}`;
  }
  if (has(input, 'delete')) return `Removing rows from ${target}`;
  if (has(input, 'completeness')) return `Proving ${target} is complete`;
  return `Updating ${target}`;
}

/**
 * Derive the semantic transcript line for one tool call.
 *
 * @param name - the tool's name (any string; unknown tools fall back to
 *   the bare name so new tools degrade gracefully)
 * @param input - the call's validated input when known; pending lines
 *   derived before execution pass undefined and get the name-only form
 */
export function deriveSemanticLine(name: string, input?: unknown): SemanticLine {
  switch (name) {
    case 'browser_execute':
      return { line: 'Running a browser program', isEvidence: false };
    case 'publish_artifact': {
      const path = field(input, 'artifact_path');
      const kind = field(input, 'kind');
      const activity =
        kind === 'screenshot'
          ? 'Publishing a screenshot'
          : kind === 'download'
            ? 'Publishing a download'
            : 'Publishing an artifact';
      return {
        line:
          path === undefined
            ? activity
            : `${activity} → ${truncate(path, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    case 'set_output_contract':
      return { line: 'Stating the output contract', isEvidence: false };
    case 'update_table':
      return { line: describeTableUpdate(input), isEvidence: false };
    case 'write_document': {
      const outputId = field(input, 'outputId');
      return {
        line: outputId === undefined ? 'Writing the document' : `Writing ${truncate(outputId, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    case 'observe':
      return { line: 'Reading the page', isEvidence: false };
    case 'browser_action':
      return { line: describeActions(input), isEvidence: false };
    case 'handle_dialog': {
      const action = field(input, 'action');
      return {
        line: action === undefined ? 'Answering a dialog' : `Answering a dialog (${action})`,
        isEvidence: false,
      };
    }
    case 'execute_javascript':
      return { line: 'Running a page script', isEvidence: false };
    case 'capture_text': {
      const label = field(input, 'label');
      return {
        line: label === undefined ? 'Capturing page text' : `Capturing "${truncate(label, TEXT_MAX)}"`,
        isEvidence: true,
      };
    }
    case 'inspect_document': {
      const path = field(input, 'path');
      return {
        line: path === undefined ? 'Reading a document' : `Reading ${truncate(path, TEXT_MAX)}`,
        isEvidence: false,
      };
    }
    case 'screenshot': {
      const filename = field(input, 'filename');
      return {
        line:
          filename === undefined
            ? 'Capturing the page'
            : `Captured ${truncate(filename, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    case 'download': {
      const filename = field(input, 'filename');
      return {
        line:
          filename === undefined
            ? 'Downloading a file'
            : `Downloaded ${truncate(filename, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    case 'grep': {
      const pattern = field(input, 'pattern');
      return {
        line:
          pattern === undefined
            ? 'Searching files'
            : `Searching files for "${truncate(pattern, TEXT_MAX)}"`,
        isEvidence: false,
      };
    }
    case 'read_file': {
      const path = field(input, 'file_path');
      return {
        line: path === undefined ? 'Re-reading notes' : `Re-reading ${truncate(path, TEXT_MAX)}`,
        isEvidence: false,
      };
    }
    case 'write_file':
    case 'edit_file': {
      const path = field(input, 'file_path');
      const verb = name === 'edit_file' ? 'Editing' : 'Writing';
      // A scratch/ write is private working state — style it as plain
      // activity even in flight, never as evidence-to-be.
      if (path !== undefined && path.startsWith('scratch/')) {
        return { line: `${verb} ${truncate(path, TEXT_MAX)}`, isEvidence: false };
      }
      return {
        line:
          path === undefined
            ? 'Saving evidence'
            : `Evidence saved → ${truncate(path, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    case 'bash': {
      const command = field(input, 'command');
      return {
        line: command === undefined ? 'Running a command' : `Running \`${truncate(command, TEXT_MAX)}\``,
        isEvidence: false,
      };
    }
    case 'ask_user_question':
    case 'ask_user':
      return { line: 'Asking you a question', isEvidence: false };
    case 'submit_for_verification':
    case 'finish':
      return { line: 'Submitting for verification', isEvidence: false };
    default:
      return { line: name, isEvidence: false };
  }
}
