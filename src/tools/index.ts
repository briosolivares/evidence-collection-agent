import type { BrowserJavaScriptPolicy } from '../browser/browserJavaScript.js';
import { deepFreezeJsonLike } from '../deepFreeze.js';
import {
  createRegistry,
  toApiToolDefs,
  type ApiToolDef,
  type ToolDef,
  type ToolRegistry,
} from './registry.js';
import { askUserTool } from './askUser/askUser.js';
import { createBashTool } from './bash/bash.js';
import { createBrowserExecuteTool } from './browserExecute/browserExecute.js';
import { editFileTool } from './editFile/editFile.js';
import { readFileTool } from './readFile/readFile.js';
import { writeFileTool } from './writeFile/writeFile.js';
import { finishTool } from './finish/finish.js';
import { publishArtifactTool } from './publishArtifact/publishArtifact.js';

/** Exact model-visible order. It is part of the byte-stable cached prefix. */
export const WORKER_TOOL_ORDER = Object.freeze([
  'browser_execute',
  'publish_artifact',
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'ask_user',
  'finish',
] as const);

export type WorkerToolName = (typeof WORKER_TOOL_ORDER)[number];

export interface WorkerToolRegistryDeps {
  /** Durable run policy for the entire browser_execute capability. */
  javascriptPolicy: BrowserJavaScriptPolicy;
  /** Exact environment names or prefixes denied to both code-execution tools. */
  secretEnvDenylist: readonly string[];
}

const STATIC_TOOLS: ReadonlyMap<WorkerToolName, ToolDef> = new Map([
  ['publish_artifact', publishArtifactTool as ToolDef],
  ['read_file', readFileTool as ToolDef],
  ['write_file', writeFileTool as ToolDef],
  ['edit_file', editFileTool as ToolDef],
  ['ask_user', askUserTool as ToolDef],
  ['finish', finishTool as ToolDef],
]);

/**
 * Build the execution registry for one run.
 *
 * `browser_execute` closes over the run's explicit JavaScript policy, and it
 * and `bash` close over a defensive copy of the secret-environment denylist.
 * Static tool definitions are then assembled with them strictly according to
 * `WORKER_TOOL_ORDER`; map/import order never decides the model-facing prefix.
 */
export function createWorkerToolRegistry(deps: WorkerToolRegistryDeps): ToolRegistry {
  const secretEnvDenylist = Object.freeze([...deps.secretEnvDenylist]);
  const runScopedTools: ReadonlyMap<WorkerToolName, ToolDef> = new Map([
    [
      'browser_execute',
      createBrowserExecuteTool({
        javascriptPolicy: deps.javascriptPolicy,
        secretEnvDenylist,
      }) as ToolDef,
    ],
    ['bash', createBashTool({ secretEnvDenylist }) as ToolDef],
  ]);

  return createRegistry(
    WORKER_TOOL_ORDER.map((name) => {
      const tool = runScopedTools.get(name) ?? STATIC_TOOLS.get(name);
      if (tool === undefined || tool.name !== name) {
        throw new Error(`tool registry invariant failed for ${JSON.stringify(name)}`);
      }
      return tool;
    }),
  );
}

/**
 * Canonical API definitions for the process-wide cached prefix.
 *
 * The throwaway registry uses an empty denylist only to materialize schemas;
 * it is neither exported nor used for execution. Policy and denylist values
 * affect tool closures, never names, descriptions, or schemas. Deep freezing
 * prevents a caller from corrupting the shared prefix for later runs.
 */
export const WORKER_API_TOOL_DEFS: readonly ApiToolDef[] = deepFreezeJsonLike(
  toApiToolDefs(
    createWorkerToolRegistry({
      javascriptPolicy: 'allow',
      secretEnvDenylist: [],
    }),
  ),
);
