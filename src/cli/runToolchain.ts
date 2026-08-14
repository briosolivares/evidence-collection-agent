/**
 * The run's tool surface.
 *
 * Owns {@link buildRunToolchain}: assembling the run-scoped stores (output
 * contract, evidence, output tables), the V2 tool registry built from them,
 * and the API-facing tool definitions the model sees. Also owns
 * {@link rehydrateContractStore}, `buildRunToolchain`'s own restore-path
 * helper — moved here from 600 lines away in the hub, next to its only
 * caller, rather than left stranded. Split into its own file because this is
 * the single largest self-contained mechanism in the hub: every tool
 * constructor it calls closes over the stores built here, and nothing
 * outside the toolchain needs to see those stores' construction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserController } from '../browser/controller.js';
import {
  toEarlyJavaScriptRequest,
  type BrowserJavaScriptPolicy,
} from '../browser/browserJavaScript.js';
import { createCaptureTextTool } from '../tools/captureText/captureText.js';
import {
  contractRevisionPath,
  createOutputContractStore,
  type OutputContractStore,
} from '../contracts/outputContractStore.js';
import type { OutputSpec } from '../contracts/outputContract.js';
import { createContentReaderRegistry } from '../content/contentReader.js';
import { createOcrContentReader } from '../content/ocrContentReader.js';
import { createPdfContentReader } from '../content/pdfContentReader.js';
import { createSpreadsheetContentReader } from '../content/spreadsheetContentReader.js';
import {
  createEvidenceStore,
  restoreEvidenceStore,
  type EvidenceStore,
} from '../evidence/evidenceStore.js';
import { createExecuteJavascriptTool } from '../tools/executeJavascript/executeJavascript.js';
import { createInspectDocumentTool } from '../tools/inspectDocument/inspectDocument.js';
import type { DocumentOutputSpec } from '../outputs/documentSource.js';
import {
  createOutputTableStore,
  restoreOutputTableStore,
  type OutputTableStore,
} from '../outputs/outputTable.js';
import { createPlaywrightPdfPageOpener } from '../outputs/renderDocument.js';
import { appendTranscriptEvent } from '../run/transcript.js';
import { createScreenshotTool } from '../tools/screenshot/screenshot.js';
import { requireBrowser } from '../tools/shared/browser.js';
import { submitForVerificationTool } from '../tools/submitForVerification/submitForVerification.js';
import { createOutputRowTools } from '../tools/updateTable/updateTable.js';
import { createToolRegistry } from '../tools/index.js';
import {
  createBusyResourceRegistry,
  toApiToolDefs,
  type ApiToolDef,
  type BusyResourceRegistry,
  type ToolDef,
  type ToolRegistry,
} from '../tools/registry.js';
import { createWriteDocumentTool } from '../tools/writeDocument/writeDocument.js';

/** Everything a run's tool surface needs beyond the bash tool: the run-scoped
 * stores (contract, evidence, tables), the assembled V2 registry, and the
 * API-facing tool definitions built from it. Shared by a fresh `runTask`
 * start and `resumeTask` — both build a brand-new toolchain (a resumed run's
 * output-contract STORE is then rehydrated from disk; its output-TABLE and
 * evidence stores are not, see resumeTask's module note on why that gap is
 * left open). */
interface RunToolchainInputs {
  runDir: string;
  browser: BrowserController;
  javascriptPolicy: BrowserJavaScriptPolicy | undefined;
  authenticated: boolean | undefined;
  bashTool: ToolDef;
  /** True when this toolchain is being built for a RESUMED run, which makes
   * every run-scoped store rebuild itself from what the interrupted process
   * already wrote instead of starting empty. Contract, evidence, and typed
   * rows are all durable; starting empty would silently discard them and then
   * fail the run for citing evidence ids "that do not exist". */
  restore?: boolean;
}

interface RunToolchain {
  outputContracts: OutputContractStore;
  evidenceStore: EvidenceStore;
  outputTables: OutputTableStore;
  /** This run's busy-resource ledger (see BusyResourceRegistry), closing the
   * "abandon, don't cancel" timeout gap for every tool call in the run. */
  busyRegistry: BusyResourceRegistry;
  registry: ToolRegistry;
  apiToolDefs: ApiToolDef[];
}

/**
 * Rehydrate a fresh `OutputContractStore` from its own durable history.
 *
 * The store itself starts every process with empty history (see
 * createOutputContractStore) — it is an in-memory index over files it wrote,
 * not something that reads its own directory back at construction. On
 * resume, every revision the run ever accepted is still on disk at
 * `scratch/output-contract/revision-<n>.json` (already integrity-checked by
 * `verifyManifestFiles` before this ever runs), so replaying them through
 * the SAME `setOutputContract` validator the original run used rebuilds an
 * identical store: same current contract, same history, same revision
 * count — without trusting the file's bytes any more than the model's
 * original call was trusted.
 */
function rehydrateContractStore(runDir: string, store: OutputContractStore): void {
  for (let revisionNumber = 1; ; revisionNumber += 1) {
    const path = join(runDir, contractRevisionPath(revisionNumber));
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      contract: unknown;
      basis?: unknown;
    };
    const result = store.setOutputContract({
      contract: parsed.contract,
      ...(parsed.basis === undefined ? {} : { revisionBasis: parsed.basis }),
    });
    if (!result.ok) {
      throw new Error(
        `failed to rehydrate contract revision ${revisionNumber} from ${path}: ` +
          `${result.errors.join('; ')}`,
      );
    }
    if (result.revision.revision !== revisionNumber) {
      throw new Error(
        `contract rehydration produced revision ${result.revision.revision} for ${path}, ` +
          `expected ${revisionNumber}`,
      );
    }
  }
}

export function buildRunToolchain(inputs: RunToolchainInputs): RunToolchain {
  const { runDir } = inputs;

  // Unconditional, and built before anything else touches the browser
  // controller: the SAME instance is threaded into every tool call via
  // ToolCtx below AND into the controller's own internal renderer-read
  // timeouts, or an abandonment recorded on one side would be invisible to
  // a gate check on the other.
  const busyRegistry = createBusyResourceRegistry();
  inputs.browser.setBusyRegistry?.(busyRegistry);

  // Run-scoped state. Built here, before the registry, because several
  // tools close over it — a tool cannot be constructed without the store it
  // mutates.
  const restore = inputs.restore === true;
  const outputContracts = createOutputContractStore(runDir);
  // Rehydrated HERE, before the table store exists, not by the caller
  // afterwards: restoring typed rows replays them through their contract's
  // validation, so the contract has to be back in place first. A caller that
  // rehydrated later would validate every restored row against an empty
  // contract and reject all of them.
  if (restore) {
    rehydrateContractStore(runDir, outputContracts);
  }
  const evidenceStore = restore ? restoreEvidenceStore(runDir) : createEvidenceStore(runDir);
  const contentReaders = createContentReaderRegistry([
    createPdfContentReader(),
    createSpreadsheetContentReader(),
    createOcrContentReader(),
  ]);
  const outputTables = (restore ? restoreOutputTableStore : createOutputTableStore)({
    // `runDir` is what makes the store persist each table after every
    // successful mutation — and therefore what makes the restore above
    // have anything to find. Passing it on the FRESH path is not
    // optional bookkeeping: without it a run writes no snapshots, and a
    // resume of that run silently starts with zero rows.
    runDir,
    tableSpec: (outputId) => {
      const current = outputContracts.currentContract();
      const found = current?.outputs.find(
        (output) => output.kind === 'table' && output.id === outputId,
      );
      return found as Extract<OutputSpec, { kind: 'table' }> | undefined;
    },
    evidenceExists: (evidenceId) => evidenceStore.get(evidenceId) !== undefined,
  });

  // The V2 registry, assembled at its frozen order (see TOOL_ORDER).
  // Tools whose dependencies this run cannot satisfy are simply absent rather
  // than present-and-broken.
  const registry = createToolRegistry(
    new Map<string, ToolDef>([
      ...createOutputRowTools({
        tables: outputTables,
        summaryDeps: () => ({
          contract: outputContracts.currentContract() ?? { outputs: [] },
          tables: outputTables,
          evidenceExists: (id) => evidenceStore.get(id) !== undefined,
          publishedExists: () => false,
          captureCount: () => 0,
        }),
      }).map((tool) => [tool.name, tool] as [string, ToolDef]),
      [
        'inspect_document',
        createInspectDocumentTool({ registry: contentReaders }) as ToolDef,
      ],
      // Contract-aware: it checks a capture's filename against the contract's
      // screenshots pattern and derives the artifact's roles from whether the
      // contract asks for screenshots at all. Read per call, so a contract
      // revision governs the very next capture.
      [
        'screenshot',
        createScreenshotTool({
          contract: () => outputContracts.currentContract(),
        }) as ToolDef,
      ],
      // execute_javascript is offered only when the session actually
      // provides the capability AND the policy allows it. An anonymous
      // session defaults to 'allow'; an authenticated one must have stated
      // its decision (resolveJavaScriptPolicy throws otherwise), so a
      // capability grant is never inherited by accident.
      ...(inputs.browser.executeJavaScript !== undefined
        ? ([
            [
              'execute_javascript',
              createExecuteJavascriptTool({
                // Read ONCE here, at configuration time: a per-call read
                // would let a later ctx mutation grant a capability no
                // operator approved.
                ...(inputs.javascriptPolicy === undefined
                  ? {}
                  : { policy: inputs.javascriptPolicy }),
                authenticatedSession: inputs.authenticated === true,
                page: (ctx) => ({
                  evaluateJson: (code, timeoutMs) =>
                    ctx.browser!.executeJavaScript!(
                      toEarlyJavaScriptRequest(code, timeoutMs),
                    ),
                  replaceUnresponsivePage: () => ctx.browser!.replaceUnresponsivePage!(),
                }),
                evidenceStore: () => evidenceStore,
                onPolicyDecision: (line) =>
                  appendTranscriptEvent(runDir, {
                    type: 'javascript_policy',
                    decision: line,
                  }),
              }) as ToolDef,
            ],
          ] as Array<[string, ToolDef]>)
        : []),
      // capture_text is offered on the same terms: only when the session
      // provides the capture seam. Without it, execute_javascript is the
      // only way to obtain the evidence id every typed row requires,
      // which makes a table task depend on page scripting being allowed.
      ...(inputs.browser.captureText !== undefined
        ? ([
            [
              'capture_text',
              createCaptureTextTool({
                page: (ctx) => ({
                  captureText: (request) => requireBrowser(ctx).captureText!(request),
                }),
                evidenceStore: () => evidenceStore,
              }) as ToolDef,
            ],
          ] as Array<[string, ToolDef]>)
        : []),
      // Publishing a prose deliverable. Both resolvers close over this
      // run's stores and are read PER CALL, never cached: a contract
      // revision must apply to the very next write, or the tool would
      // publish yesterday's filename.
      //
      // `openPdfPage` is offered only when the session can hand out a
      // throwaway page. Without it a `pdf` output fails explicitly before
      // anything is written, which is the failure worth having — the
      // alternative is a text file published under a .pdf name that the
      // verifier accepts and a human cannot open.
      [
        'write_document',
        createWriteDocumentTool({
          documentSpecs: () =>
            (outputContracts.currentContract()?.outputs ?? []).filter(
              (output): output is DocumentOutputSpec => output.kind === 'document',
            ),
          evidence: () => (id) => evidenceStore.get(id),
          ...(inputs.browser.pdfPageSource === undefined
            ? {}
            : {
                openPdfPage: () =>
                  createPlaywrightPdfPageOpener(inputs.browser.pdfPageSource!())(),
              }),
        }) as ToolDef,
      ],
      // Local code execution, at its frozen position in TOOL_ORDER.
      // Run-scoped for the same reason the stores above are: it carries
      // this run's secret-env denylist.
      ['bash', inputs.bashTool],
    ]),
  );

  // The model's tool surface follows the registry exactly, plus the submission
  // CONTROL tool — offered to the model but never executed through the
  // pipeline (the session intercepts it), which is why it is appended here and
  // not registered above.
  const apiToolDefs = [...toApiToolDefs(registry), submitForVerificationTool];

  return {
    outputContracts,
    evidenceStore,
    outputTables,
    busyRegistry,
    registry,
    apiToolDefs,
  };
}
