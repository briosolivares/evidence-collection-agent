/**
 * The agent's tool set: one directory per tool, assembled here in one frozen
 * order.
 *
 * The surface is declared as DATA, in one place, so the order that feeds the
 * cached prompt prefix is reviewable and a snapshot test can pin it. Prompt
 * caching is a byte-exact prefix match: reordering these names silently
 * invalidates every cached prefix and re-pays the whole conversation at write
 * rates, which is why the order is frozen rather than derived from whatever
 * sequence the modules happen to be imported in.
 *
 * Tools whose construction needs run-scoped state (the contract store, the
 * table store, the evidence store, a content reader) are FACTORIES, so they
 * cannot appear in a static map. They are named in `V2_TOOL_ORDER` at their
 * frozen positions and built by `runTask`; that array is the single authority
 * on where each one goes.
 *
 * The file tools borrow Claude Code's shapes — tool and parameter names
 * (file_path / offset / limit, pattern / path), cat -n style line-numbered
 * reads, grep results one match per line — because the model has seen those
 * exact contracts in training and uses familiar tools correctly more often.
 * The implementations are minimal Node reimplementations confined to the run
 * directory: every model-supplied path goes through `resolveRunPath`, and every
 * write goes through `writeArtifact` so the manifest records it. Their shared
 * error contract: a violated precondition (escaping path, missing file,
 * invalid pattern) throws with a model-readable message, and the pipeline
 * converts the throw into a structured error result, so callers never see an
 * exception.
 */
import { createRegistry, type ToolDef, type ToolRegistry } from './registry.js';

import { askUserQuestionTool } from './askUserQuestion/askUserQuestion.js';
import { browserActionTool } from './browserAction/browserAction.js';
import { downloadTool } from './download/download.js';
import { editFileTool } from './editFile/editFile.js';
import { grepTool } from './grep/grep.js';
import { handleDialogTool } from './handleDialog/handleDialog.js';
import { observeTool } from './observe/observe.js';
import { readFileTool } from './readFile/readFile.js';
import { setOutputContractTool } from './setOutputContract/setOutputContract.js';
import { writeFileTool } from './writeFile/writeFile.js';

export {
  askUserQuestionTool,
  type AskUserAnswers,
  type AskUserQuestionInput,
} from './askUserQuestion/askUserQuestion.js';
export {
  createBashTool,
  type BashInput,
  type BashResult,
  type BashToolDeps,
} from './bash/bash.js';
export { downloadTool, type DownloadInput } from './download/download.js';
export { editFileTool, type EditFileResult } from './editFile/editFile.js';
export { grepTool } from './grep/grep.js';
export { readFileTool } from './readFile/readFile.js';
export {
  createScreenshotTool,
  type ScreenshotInput,
  type ScreenshotToolDeps,
} from './screenshot/screenshot.js';
export { writeFileTool } from './writeFile/writeFile.js';
export { type EvidenceResult } from './shared/evidence.js';

/**
 * Every production tool name, in the exact order the registry must build them.
 * `set_output_contract` is first because it gates everything else, and
 * `submit_for_verification` is last because it ends the run.
 */
export const V2_TOOL_ORDER: readonly string[] = [
  // The contract gate.
  'set_output_contract',
  // Typed output construction.
  'update_table',
  'write_document',
  // Observation and action.
  'observe',
  'browser_action',
  'handle_dialog',
  'execute_javascript',
  // Reading the world.
  'capture_text',
  'inspect_document',
  // Evidence capture.
  'screenshot',
  'download',
  // Files, for scratch and supporting work.
  'read_file',
  'write_file',
  'edit_file',
  'grep',
  // Local code execution, worker-only. Last of the file group because a
  // command is the heaviest thing this group can do, and because `bash` is
  // built per run (it closes over the secret-env denylist) rather than being
  // a static definition like the tools above it.
  'bash',
  // The human.
  'ask_user_question',
  // Completion.
  'submit_for_verification',
];

/**
 * The tools that are plain definitions, keyed by name — everything not
 * requiring run-scoped construction. `runTask` merges these with the factories
 * it builds, ordered by `V2_TOOL_ORDER`.
 */
export const V2_STATIC_TOOLS: ReadonlyMap<string, ToolDef> = new Map<string, ToolDef>([
  // Browser tools that take their session from ToolCtx and so need no
  // run-scoped construction.
  ['observe', observeTool as ToolDef],
  ['browser_action', browserActionTool as ToolDef],
  ['handle_dialog', handleDialogTool as ToolDef],
  ['set_output_contract', setOutputContractTool as ToolDef],
  ['download', downloadTool],
  ['read_file', readFileTool as ToolDef],
  ['write_file', writeFileTool as ToolDef],
  ['edit_file', editFileTool as ToolDef],
  ['grep', grepTool as ToolDef],
  // NOTE: 'bash' and 'screenshot' are deliberately absent — both are
  // factories (bash closes over the secret-env denylist, screenshot over the
  // output contract), so runTask builds them and supplies them as run-scoped
  // tools at their frozen positions.
  ['ask_user_question', askUserQuestionTool as ToolDef],
]);

/**
 * Assemble the registry from the static tools plus whatever run-scoped tools
 * the caller built, ordered by `V2_TOOL_ORDER`.
 *
 * @param runScopedTools - factory-built tools, keyed by name
 * @returns a registry whose iteration order matches `V2_TOOL_ORDER`, skipping
 *   names the caller did not supply. Skipping rather than throwing is
 *   deliberate: a run legitimately omits a tool whose capability its session
 *   cannot provide (no page scripting, no PDF page source), and the order of
 *   what remains must still be stable
 * @throws if a supplied tool's name is absent from `V2_TOOL_ORDER` — that means
 *   a new tool was added without deciding where it belongs, which would let
 *   its position drift and break the cached prefix
 */
export function createV2Registry(
  runScopedTools: ReadonlyMap<string, ToolDef> = new Map(),
): ToolRegistry {
  const frozen = new Set(V2_TOOL_ORDER);
  for (const name of runScopedTools.keys()) {
    if (!frozen.has(name)) {
      throw new Error(
        `tool "${name}" is not in V2_TOOL_ORDER — add it there so its position is frozen`,
      );
    }
  }
  const ordered: ToolDef[] = [];
  for (const name of V2_TOOL_ORDER) {
    const tool = runScopedTools.get(name) ?? V2_STATIC_TOOLS.get(name);
    if (tool !== undefined) ordered.push(tool);
  }
  return createRegistry(ordered);
}
