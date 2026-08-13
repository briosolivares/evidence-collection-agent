/**
 * The agent's tool set, one directory per tool, grouped here in stable
 * registration order. `createRegistry` and `toApiToolDefs` depend on these
 * arrays being deterministic — reordering them changes the prompt prefix
 * and breaks prompt caching.
 */
import { createRegistry, type ToolDef, type ToolRegistry } from './registry.js';

import { askUserQuestionTool } from './askUserQuestion/askUserQuestion.js';
import { browserBatchTool } from './browserBatch/browserBatch.js';
import { clickTool } from './click/click.js';
import { downloadTool } from './download/download.js';
import { fillCredentialsTool } from './fillCredentials/fillCredentials.js';
import { grepTool } from './grep/grep.js';
import { inspectPageTool } from './inspectPage/inspectPage.js';
import { navigateTool } from './navigate/navigate.js';
import { readFileTool } from './readFile/readFile.js';
import { screenshotTool } from './screenshot/screenshot.js';
import { scrollTool } from './scroll/scroll.js';
import { typeTool } from './type/type.js';
import { writeFileTool } from './writeFile/writeFile.js';

export {
  askUserQuestionTool,
  type AskUserAnswers,
  type AskUserQuestionInput,
} from './askUserQuestion/askUserQuestion.js';
export { clickTool } from './click/click.js';
export {
  browserBatchTool,
  type BrowserBatchAction,
  type BrowserBatchActionResult,
  type BrowserBatchInput,
  type BrowserBatchResult,
} from './browserBatch/browserBatch.js';
export { downloadTool, type DownloadInput } from './download/download.js';
export {
  fillCredentialsTool,
  type FillCredentialsInput,
} from './fillCredentials/fillCredentials.js';
export { grepTool } from './grep/grep.js';
export { inspectPageTool, type InspectPageInput } from './inspectPage/inspectPage.js';
export { navigateTool, type NavigateInput } from './navigate/navigate.js';
export { readFileTool } from './readFile/readFile.js';
export { screenshotTool, type ScreenshotInput } from './screenshot/screenshot.js';
export { scrollTool } from './scroll/scroll.js';
export { typeTool } from './type/type.js';
export { writeFileTool } from './writeFile/writeFile.js';
export { type EvidenceResult } from './shared/evidence.js';

// The three file tools borrow Claude Code's shapes — tool and parameter
// names (file_path / offset / limit, pattern / path), cat -n style
// line-numbered reads, grep results one match per line — because the model
// has seen those exact contracts in training and uses familiar tools
// correctly more often. The implementations are minimal Node reimplementations
// confined to the run directory: every model-supplied path goes through
// resolveRunPath, and every write goes through writeArtifact so the manifest
// records it (the design's invisible-plumbing rule).
//
// Error contract shared by all three: a violated precondition (escaping
// path, missing file, invalid pattern) throws with a model-readable message;
// the pipeline (executeToolCall) converts the throw into a structured error
// result, so callers never see an exception.

/** The file tools in registration order, ready for `createRegistry`. */
export const fileTools: readonly ToolDef[] = [
  readFileTool as ToolDef,
  writeFileTool as ToolDef,
  grepTool as ToolDef,
];

/** Browser observation tools in stable registration order. */
export const observationTools: readonly ToolDef[] = [
  navigateTool,
  inspectPageTool,
];

/** The state-changing browser action tools in stable registration order. */
export const actionTools: readonly ToolDef[] = [clickTool, typeTool, scrollTool];

/** Browser evidence tools in stable registration order. */
export const evidenceTools: readonly ToolDef[] = [screenshotTool, downloadTool];

/** Authentication tools in stable registration order. Appended after the
 * original ten so their order — and the cached prompt prefix bytes they
 * contribute — never shifts. */
export const authTools: readonly ToolDef[] = [fillCredentialsTool as ToolDef];

/** User-interaction tools in stable registration order. Only these pass
 * through the pipeline's permission gate; headless environments fail them
 * closed. */
export const interactionTools: readonly ToolDef[] = [
  askUserQuestionTool as ToolDef,
];

/** Deterministic model/runtime tool surfaces used by production entry points. */
export type ToolProfile = 'atomic' | 'batch-enabled';

/** The regression-safe production default during the browser-batch experiment. */
export const DEFAULT_TOOL_PROFILE: ToolProfile = 'atomic';

/**
 * Build one complete production registry. The atomic profile retains the
 * existing ten tools and their exact order (plus the appended auth tools);
 * the treatment appends the composite browser tool without replacing any
 * atomic capability.
 */
export function createProductionRegistry(
  profile: ToolProfile = DEFAULT_TOOL_PROFILE,
): ToolRegistry {
  return createRegistry([
    ...fileTools,
    ...observationTools,
    ...actionTools,
    ...evidenceTools,
    ...authTools,
    ...interactionTools,
    ...(profile === 'batch-enabled' ? [browserBatchTool] : []),
  ]);
}

// --- T16: the frozen V2 tool order -------------------------------------------
//
// The V2 surface is declared as DATA, in one place, so the order that feeds the
// cached prompt prefix is reviewable and a snapshot test can pin it. Prompt
// caching is a byte-exact prefix match: reordering these names silently
// invalidates every cached prefix and re-pays the whole conversation at write
// rates, which is why the order is frozen rather than derived from whatever
// sequence the modules happen to be imported in.
//
// Tools whose construction needs run-scoped state (the contract store, the
// table store, the evidence store, a browser reader) are FACTORIES, so they
// cannot appear in a static array. They are named here in their frozen
// positions and built by runTask; V2_TOOL_ORDER is the authority on where each
// one goes.

/**
 * Every V2 production tool name, in the exact order the registry must build
 * them. `set_output_contract` is first because it gates everything else, and
 * `submit_for_verification` is last because it ends the run.
 */
export const V2_TOOL_ORDER: readonly string[] = [
  // The contract gate.
  'set_output_contract',
  // Typed output construction.
  'upsert_output_rows',
  'delete_output_rows',
  'set_table_completeness',
  'write_document',
  // Observation and action.
  'observe',
  'browser_action',
  'switch_page',
  'handle_dialog',
  'execute_javascript',
  // Reading the world.
  'read_resource',
  'capture_text',
  'inspect_document',
  // Evidence capture.
  'screenshot',
  'download',
  // Files, for scratch and supporting work.
  'read_file',
  'write_file',
  'grep',
  // Credentials and the human.
  'fill_credentials',
  'ask_user_question',
  // Parallel research.
  'run_research_jobs',
  // Completion.
  'submit_for_verification',
];

/**
 * The V2 tools that are plain definitions, keyed by name — everything not
 * requiring run-scoped construction. runTask merges these with the factories
 * it builds, ordered by V2_TOOL_ORDER.
 */
export const V2_STATIC_TOOLS: ReadonlyMap<string, ToolDef> = new Map<string, ToolDef>([
  ['screenshot', screenshotTool],
  ['download', downloadTool],
  ['read_file', readFileTool as ToolDef],
  ['write_file', writeFileTool as ToolDef],
  ['grep', grepTool as ToolDef],
  ['fill_credentials', fillCredentialsTool as ToolDef],
  ['ask_user_question', askUserQuestionTool as ToolDef],
]);

/**
 * Assemble a V2 registry from the static tools plus whatever run-scoped tools
 * the caller built, ordered by V2_TOOL_ORDER.
 *
 * @param runScopedTools - factory-built tools, keyed by name
 * @returns a registry whose iteration order matches V2_TOOL_ORDER, skipping
 *   names the caller did not supply. Skipping rather than throwing is
 *   deliberate: a run legitimately omits tools it cannot use (no credentials,
 *   no research runner), and the order of what remains must still be stable
 * @throws if a supplied tool's name is absent from V2_TOOL_ORDER — that means
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
