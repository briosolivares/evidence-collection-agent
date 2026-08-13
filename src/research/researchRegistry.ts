/**
 * The tool set a research child gets (T14): observe, act, run page
 * JavaScript, read public resources, and capture evidence. Nothing else.
 *
 * Every tool here is SELECTED from an existing factory or module constant —
 * this file writes no tool of its own. That is deliberate: a child that
 * browses through a second, parallel implementation of `observe` would be
 * exercising untested code paths on the run's behalf, and any divergence
 * would show up as an unexplained difference between what the coordinator
 * and the children can see.
 *
 * What is deliberately absent, and why:
 *
 *  - `upsert_output_rows` / `delete_output_rows` / `set_table_completeness` —
 *    children propose candidate rows in their typed result; only the
 *    coordinator writes the run's tables, so there is no shared mutable
 *    table for concurrent jobs to race on.
 *  - `set_output_contract` — the contract is the run's agreement with the
 *    user. A child that could revise it could move the goalposts for every
 *    other job mid-flight.
 *  - `submit_for_verification` — a child does not end the run.
 *  - `write_file` / `write_document` / `screenshot` / `download` — these
 *    publish artifacts. A child writing into `artifacts/` (even its own
 *    job-local one) would be producing deliverables nobody asked it for.
 *  - `fill_credentials` — children are anonymous by construction (see
 *    `ResearchJob.headed`), so there is no credential to fill.
 *  - `ask_user_question` — children run headless; a question they cannot ask
 *    would just fail closed, and the coordinator owns the conversation.
 *  - `run_research_jobs` — no recursion. One bounded level of fan-out is the
 *    whole design.
 *
 * `read_file` and `grep` ARE included, and the reason matters: a bulk
 * extraction that exceeds the inline budget is offloaded to a file, and
 * without a read tool the child would be handed a path it cannot open. Both
 * are read-only and both resolve every path through `resolveRunPath` against
 * the CHILD's run directory — which is its own job directory — so they can
 * read only what that job itself produced. They grant no reach into the run's
 * deliverables, the contract documents, or another job's workspace.
 */

import type { BrowserJavaScriptPolicy, JavaScriptCapablePage } from '../browser/browserJavaScript.js';
import type { DiscoveredUrlIndex } from '../browser/discoveredUrlIndex.js';
import type { PublicResourceReader } from '../browser/publicResourceReader.js';
import type { EvidenceStore } from '../evidence/evidenceStore.js';
import { browserActionTool } from '../tools/browserAction/browserAction.js';
import { createCaptureTextTool, type TextCapturePage } from '../tools/captureText/captureText.js';
import { createExecuteJavascriptTool } from '../tools/executeJavascript/executeJavascript.js';
import { grepTool } from '../tools/grep/grep.js';
import { handleDialogTool } from '../tools/handleDialog/handleDialog.js';
import { observeTool } from '../tools/observe/observe.js';
import { readFileTool } from '../tools/readFile/readFile.js';
import { createReadResourceTool } from '../tools/readResource/readResource.js';
import { switchPageTool } from '../tools/switchPage/switchPage.js';
import { createRegistry, type ToolCtx, type ToolDef, type ToolRegistry } from '../tools/registry.js';

/**
 * Tool names a research registry must NOT contain. Checked at dispatch by
 * {@link assertResearchRegistry}, so a mis-wired registry fails the job
 * loudly instead of quietly handing a child the coordinator's authority.
 *
 * `run_research_jobs` is spelled out rather than imported from the tool
 * module: importing it would make this module depend on the tool that
 * depends on it, and the tool's own test asserts the two strings agree.
 */
export const FORBIDDEN_RESEARCH_TOOL_NAMES: readonly string[] = [
  'upsert_output_rows',
  'delete_output_rows',
  'set_table_completeness',
  'set_output_contract',
  'submit_for_verification',
  'write_file',
  'write_document',
  'screenshot',
  'download',
  'fill_credentials',
  'ask_user_question',
  'run_research_jobs',
];

/** Everything a research registry needs from the child's own session. Every
 * seam is per-job: the browser context, the resource reader, the URL
 * provenance index, and the evidence ledger all belong to ONE job. */
export interface ResearchRegistryDeps {
  /** JavaScript-capable page seam for this child's browser context. */
  javascriptPage: (ctx: ToolCtx) => JavaScriptCapablePage;
  /** Exact-text capture seam for this child's browser context. */
  textCapturePage: (ctx: ToolCtx) => TextCapturePage;
  /** Anonymous public reader for this child. */
  resourceReader: (ctx: ToolCtx) => PublicResourceReader;
  /** This child's URL provenance index — the same instance its navigation
   * and observation paths feed. A shared index would let one job read URLs
   * only another job ever saw. */
  discoveredUrls: (ctx: ToolCtx) => DiscoveredUrlIndex;
  /** This JOB's evidence ledger (rooted in the job directory, so two
   * concurrent jobs cannot collide on `E1`'s bytes). */
  evidenceStore: (ctx: ToolCtx) => EvidenceStore | undefined;
  /** Page-JavaScript policy. Children are anonymous, so an unset policy
   * resolves to `allow` without an operator decision — see
   * `assertJavaScriptPolicy`. Pass `'deny'` to withhold it. */
  javascriptPolicy?: BrowserJavaScriptPolicy;
  /** Receives the one-line policy decision, for the run log. */
  onPolicyDecision?: (line: string) => void;
}

/**
 * Build one research child's restricted registry.
 *
 * Registration order is fixed and deterministic: the API tool array is part
 * of the cached prompt prefix every concurrent job shares, so reordering
 * these would cost every job a cache write.
 *
 * @param deps - this child's page, resource, provenance, and evidence seams
 * @returns the child's registry, containing only observe/action/JavaScript/
 *   resource/evidence tools plus the two confined read tools
 * @throws Error from `createExecuteJavascriptTool` when a `deny`-worthy
 *   session was configured inconsistently (an authenticated child is not a
 *   thing this path can produce, so in practice only a bad byte budget
 *   throws here)
 */
export function createResearchRegistry(deps: ResearchRegistryDeps): ToolRegistry {
  const javascriptTool = createExecuteJavascriptTool({
    page: deps.javascriptPage,
    evidenceStore: deps.evidenceStore,
    ...(deps.javascriptPolicy === undefined ? {} : { policy: deps.javascriptPolicy }),
    // A research child never carries logged-in state: headed/authenticated
    // assignments are refused before a session is ever created.
    authenticatedSession: false,
    ...(deps.onPolicyDecision === undefined ? {} : { onPolicyDecision: deps.onPolicyDecision }),
  });
  const captureTool = createCaptureTextTool({
    page: deps.textCapturePage,
    evidenceStore: deps.evidenceStore,
  });
  const resourceTool = createReadResourceTool({
    reader: deps.resourceReader,
    discoveredUrls: deps.discoveredUrls,
    evidenceStore: deps.evidenceStore,
  });

  return createRegistry([
    // Observe.
    observeTool as ToolDef,
    // Act on one page, switch pages, answer a blocking dialog.
    browserActionTool as ToolDef,
    switchPageTool as ToolDef,
    handleDialogTool as ToolDef,
    // Page JavaScript, for bulk extraction in one call.
    javascriptTool as ToolDef,
    // Public resources and exact-text evidence.
    resourceTool as ToolDef,
    captureTool as ToolDef,
    // Read back what this job itself offloaded; confined to the job dir.
    readFileTool as ToolDef,
    grepTool as ToolDef,
  ]);
}

/**
 * Refuse a registry that would give a child more than research authority.
 *
 * Called by the job runner on every created session. A wiring mistake here
 * is exactly the failure the whole isolation argument rests on, and it is
 * invisible at runtime otherwise — a child would simply start writing the
 * run's table and nobody would see anything wrong until the deliverable was.
 *
 * @param registry - the registry a session factory produced
 * @throws Error naming every forbidden tool present
 */
export function assertResearchRegistry(registry: ToolRegistry): void {
  const present = FORBIDDEN_RESEARCH_TOOL_NAMES.filter((name) => registry.has(name));
  if (present.length > 0) {
    throw new Error(
      `a research job's registry must not contain ${present.join(', ')}: a child ` +
        `proposes candidate rows and cannot write the run's outputs, revise its ` +
        `contract, publish artifacts, use credentials, or start further jobs`,
    );
  }
}
