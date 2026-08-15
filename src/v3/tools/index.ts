import {
  createRegistry,
  toApiToolDefs,
  type ApiToolDef,
  type ToolDef,
  type ToolRegistry,
} from '../../tools/registry.js';
import { askUserTool } from './askUser.js';
import { createBashTool } from './bash.js';
import { createBrowserExecuteTool } from './browserExecute.js';
import { editFileTool, readFileTool, writeFileTool } from './fileTools.js';
import { finishTool } from './finish.js';
import { publishArtifactTool } from './publishArtifact.js';

/** Exact model-visible order. It is part of the byte-stable cached prefix. */
export const V3_TOOL_ORDER = Object.freeze([
  'browser_execute',
  'publish_artifact',
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'ask_user',
  'finish',
] as const);

export type V3ToolName = (typeof V3_TOOL_ORDER)[number];

export interface V3ToolRegistryDeps {
  /** Exact environment names or prefixes denied to both code-execution tools. */
  secretEnvDenylist: readonly string[];
}

const STATIC_TOOLS: ReadonlyMap<V3ToolName, ToolDef> = new Map([
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
 * `browser_execute` and `bash` close over a defensive copy of the run's
 * secret-environment denylist. Static tool definitions are then assembled
 * with them strictly according to `V3_TOOL_ORDER`; map/import order is never
 * allowed to decide the model-facing prefix.
 */
export function createV3ToolRegistry(deps: V3ToolRegistryDeps): ToolRegistry {
  const secretEnvDenylist = Object.freeze([...deps.secretEnvDenylist]);
  const runScopedTools: ReadonlyMap<V3ToolName, ToolDef> = new Map([
    [
      'browser_execute',
      createBrowserExecuteTool({ secretEnvDenylist }) as ToolDef,
    ],
    ['bash', createBashTool({ secretEnvDenylist }) as ToolDef],
  ]);

  return createRegistry(
    V3_TOOL_ORDER.map((name) => {
      const tool = runScopedTools.get(name) ?? STATIC_TOOLS.get(name);
      if (tool === undefined || tool.name !== name) {
        throw new Error(
          `v3 tool registry invariant failed for ${JSON.stringify(name)}`,
        );
      }
      return tool;
    }),
  );
}

/**
 * Canonical API definitions for the process-wide cached prefix.
 *
 * The throwaway registry uses an empty denylist only to materialize schemas;
 * it is neither exported nor used for execution. Denylist values affect tool
 * closures, never names, descriptions, or schemas. Deep freezing prevents a
 * caller from corrupting the shared prefix for later runs.
 */
export const V3_API_TOOL_DEFS: readonly ApiToolDef[] = deepFreeze(
  toApiToolDefs(createV3ToolRegistry({ secretEnvDenylist: [] })),
);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
