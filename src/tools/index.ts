/**
 * The agent's tool set, one directory per tool, grouped here in stable
 * registration order. `createRegistry` and `toApiToolDefs` depend on these
 * arrays being deterministic — reordering them changes the prompt prefix
 * and breaks prompt caching.
 */
import type { ToolDef } from './registry.js';

import { clickTool } from './click/click.js';
import { downloadTool } from './download/download.js';
import { grepTool } from './grep/grep.js';
import { inspectPageTool } from './inspectPage/inspectPage.js';
import { navigateTool } from './navigate/navigate.js';
import { readFileTool } from './readFile/readFile.js';
import { screenshotTool } from './screenshot/screenshot.js';
import { scrollTool } from './scroll/scroll.js';
import { typeTool } from './type/type.js';
import { writeFileTool } from './writeFile/writeFile.js';

export { clickTool } from './click/click.js';
export { downloadTool, type DownloadInput } from './download/download.js';
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
