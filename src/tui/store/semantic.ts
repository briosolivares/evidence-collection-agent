import { truncate } from '../format.js';

// Human-readable activity for the exact worker surface. Publication gets
// the pending evidence style; final artifact truth still comes from manifest
// diffs in the reducer/tracing bridge.

const TEXT_MAX = 40;

export interface SemanticLine {
  line: string;
  isEvidence: boolean;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function deriveSemanticLine(
  name: string,
  input?: unknown,
): SemanticLine {
  switch (name) {
    case 'browser_execute':
      return { line: 'Running a browser program', isEvidence: false };
    case 'publish_artifact': {
      const kind = field(input, 'kind');
      const path = field(input, 'artifact_path');
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
    case 'read_file': {
      const path = field(input, 'file_path');
      return {
        line:
          path === undefined
            ? 'Reading a file'
            : `Reading ${truncate(path, TEXT_MAX)}`,
        isEvidence: false,
      };
    }
    case 'write_file':
    case 'edit_file': {
      const path = field(input, 'file_path');
      const verb = name === 'edit_file' ? 'Editing' : 'Writing';
      return {
        line:
          path === undefined
            ? `${verb} a private file`
            : `${verb} ${truncate(path, TEXT_MAX)}`,
        isEvidence: false,
      };
    }
    case 'bash': {
      const command = field(input, 'command');
      return {
        line:
          command === undefined
            ? 'Running a command'
            : `Running \`${truncate(command, TEXT_MAX)}\``,
        isEvidence: false,
      };
    }
    case 'ask_user':
      return { line: 'Asking you a question', isEvidence: false };
    case 'finish':
      return { line: 'Submitting for verification', isEvidence: false };
    default:
      return { line: name, isEvidence: false };
  }
}
