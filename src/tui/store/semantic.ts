// Pure derivation of semantic transcript lines from tool calls (design
// "Semantic line derivation" table): tool activity reads as what the
// agent is doing (`Opening sec.gov/…`), never raw JSON; evidence-
// producing tools are classified for the stronger ◆ treatment (R5).

import { shortenUrl, truncate } from '../format.js';

/** Maximum rendered length for interpolated fragments. */
const TEXT_MAX = 40;
const LINE_URL_MAX = 44;

/** One derived line: its text and whether it is evidence. */
export interface SemanticLine {
  line: string;
  isEvidence: boolean;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
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
    case 'navigate': {
      const url = field(input, 'url');
      return {
        line: url === undefined ? 'Opening a page' : `Opening ${shortenUrl(url, LINE_URL_MAX)}`,
        isEvidence: false,
      };
    }
    case 'inspect_page':
      return { line: 'Reading the page', isEvidence: false };
    case 'click': {
      const ref = field(input, 'ref');
      return {
        line: ref === undefined ? 'Clicking' : `Clicking ${ref}`,
        isEvidence: false,
      };
    }
    case 'type': {
      const text = field(input, 'text');
      return {
        line: text === undefined ? 'Typing' : `Typing "${truncate(text, TEXT_MAX)}"`,
        isEvidence: false,
      };
    }
    case 'scroll':
      return { line: 'Scrolling', isEvidence: false };
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
    case 'write_file': {
      const path = field(input, 'file_path');
      return {
        line:
          path === undefined
            ? 'Saving evidence'
            : `Evidence saved → ${truncate(path, TEXT_MAX)}`,
        isEvidence: true,
      };
    }
    default:
      return { line: name, isEvidence: false };
  }
}
