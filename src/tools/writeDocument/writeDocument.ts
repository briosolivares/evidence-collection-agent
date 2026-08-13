/**
 * INTEGRATION (T8) — this tool is complete and tested but deliberately NOT
 * registered: registry.ts, index.ts, the controller, and completionCheck.ts
 * belong to other agents. Five wiring steps remain, and nothing in this file
 * needs to change for them:
 *
 * 1. `src/tools/registry.ts` — add one optional field to `ToolCtx` (T6 adds
 *    the same one, so this may already be there):
 *      `evidenceStore?: EvidenceStore`   (src/evidence/evidenceStore.js)
 *    `outputContracts?: OutputContractStore` already exists and is what the
 *    `documentSpecs` dep below reads.
 *
 * 2. Build the tool where the run's registry is built:
 *      createWriteDocumentTool({
 *        documentSpecs: (ctx) =>
 *          (ctx.outputContracts?.currentContract()?.outputs ?? [])
 *            .filter((output) => output.kind === 'document'),
 *        evidence: (ctx) =>
 *          ctx.evidenceStore === undefined ? undefined : (id) => ctx.evidenceStore!.get(id),
 *        openPdfPage: createPlaywrightPdfPageOpener(browser),
 *      })
 *    Both resolvers are read PER CALL, on purpose: a contract revision must
 *    apply to the very next write, and the ledger is run-scoped.
 *
 * 3. `openPdfPage` needs a Playwright `Browser` (preferred) or
 *    `BrowserContext` that is NOT the worker's page. Today
 *    `LocalChromeBrowserSessionProvider` keeps its context private, so expose
 *    one accessor there — e.g. `pdfPageSource(): Pick<Browser, 'newPage'>` on
 *    `BrowserController` — and pass it straight to
 *    `createPlaywrightPdfPageOpener`. Omitting the dep is safe: a `pdf`
 *    document then fails with an explicit "this run cannot render PDFs"
 *    error before anything is written, rather than publishing a text file
 *    with a .pdf name.
 *
 * 4. `src/tools/index.ts` — export a `documentTools` array and spread it LAST
 *    inside `createProductionRegistry`, after the existing conditional tools.
 *    Appending last is the only position where no existing tool's index moves,
 *    so the cached prompt prefix keeps its bytes.
 *
 * 5. `src/completion/completionCheck.ts` — `validateDocumentOutputs()` (plan
 *    step 6): a contract-bound document output must be satisfiable ONLY through
 *    this tool. `checkDocumentOutput` already checks existence, required
 *    sections, and placeholders; what is missing is the negative check — a
 *    document output whose published file has no matching
 *    `scratch/documents/<outputId>/source.md` manifest entry was hand-written
 *    with write_file and must fail the check. Both paths are already in the
 *    manifest, so this needs no new bookkeeping.
 */

import { z } from 'zod';

import {
  documentSourcePath,
  EVIDENCE_MARKER_SYNTAX,
  parseEvidenceMarkers,
  validateDocumentEvidence,
  type DocumentEvidenceLookup,
  type DocumentOutputSpec,
} from '../../outputs/documentSource.js';
import {
  renderDocument,
  renderPdf,
  type PdfRenderPage,
} from '../../outputs/renderDocument.js';
import { ARTIFACTS_DIR, writeArtifact } from '../../run/artifacts.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import { classifyWorkspacePath } from '../shared/evidence.js';

// Publishing a prose deliverable. The model supplies ONE thing — the
// evidence-marked text — and the contract supplies everything else: the
// filename, the format, the required sections, how much evidence is needed,
// and whether citations are visible. That asymmetry is the point. A tool that
// also accepted a filename or a presentation mode would let a drifting model
// quietly renegotiate the deliverable it was asked for, and the run would
// still look successful.
//
// Three orderings are load-bearing, each tested directly:
//
//  1. Check, then render, then write. Every failure mode — an unknown
//     evidence id, an uncited required section, a PDF this run cannot render —
//     lands before the first byte is written, so a rejected call leaves no
//     file and no manifest entry to confuse the verifier.
//  2. Source first, published output second. The reviewable input exists on
//     disk before the deliverable derived from it, and both are hashed.
//  3. One accepted source, every rendering. The bytes published under
//     artifacts/ are a pure function of the same AcceptedDocumentSource the
//     scratch copy holds, whatever the format — so "the PDF says something the
//     marked source does not" is not a state this tool can produce.

/** Registry name of this tool. */
export const WRITE_DOCUMENT_TOOL_NAME = 'write_document';

/**
 * The model-facing input, and deliberately nothing more. Filename, format,
 * required sections, evidence coverage, and citation presentation all come
 * from the contract: they are requirements, not per-call choices, and a
 * second place to state them is a second place for them to disagree.
 */
export const writeDocumentInputSchema = z.strictObject({
  outputId: z
    .string()
    .min(1)
    .describe('Id of the document output in the current contract, e.g. "summary_brief"'),
  content: z
    .string()
    .min(1)
    .describe(
      'The document\'s complete text, with inline evidence markers. ' +
        `${EVIDENCE_MARKER_SYNTAX} Write the required sections as headings spelled exactly ` +
        'as the contract declares them. Do not add a citation list or footnote numbers ' +
        'yourself — the runtime renders them from your markers.',
    ),
});

/** Input accepted by the write_document tool. */
export type WriteDocumentInput = z.infer<typeof writeDocumentInputSchema>;

/** What the model gets back: where both files landed, what they hash to, and
 * which records the document ended up resting on. */
export interface WriteDocumentResult {
  /** The contract output this satisfied. */
  outputId: string;
  /** Run-dir-relative path of the published deliverable. */
  publishedPath: string;
  /** SHA-256 of the published bytes, as recorded in the manifest. */
  publishedSha256: string;
  /** Size of the published deliverable in bytes. */
  publishedBytes: number;
  /** The contract's format, echoed so the model can see what was produced. */
  format: DocumentOutputSpec['format'];
  /** How citations were presented, from the contract. */
  evidencePresentation: DocumentOutputSpec['evidencePresentation'];
  /** Run-dir-relative path of the marked source kept for review. */
  sourcePath: string;
  /** SHA-256 of the marked source's bytes. */
  sourceSha256: string;
  /** Evidence ids the document cites, in first-appearance order — the same
   * order footnote numbers follow. */
  citedEvidenceIds: string[];
}

/**
 * Everything the tool needs from the run that `ToolCtx` cannot yet give it.
 * A factory rather than a module-level tool because the PDF page source is a
 * session-scoped decision made where the browser is created (see the
 * INTEGRATION note above).
 */
export interface WriteDocumentDeps {
  /**
   * The current contract's document outputs, in contract order. Read per
   * call, never cached: a contract revision must apply to the very next
   * write, and a cached spec would publish yesterday's filename.
   */
  documentSpecs: (ctx: ToolCtx) => readonly DocumentOutputSpec[];
  /**
   * Resolve the run's evidence lookup, or undefined for a run with no ledger
   * (fixture tests, contract-less paths). A document that cites anything then
   * fails rather than publishing citations nothing can back.
   */
  evidence?: (ctx: ToolCtx) => DocumentEvidenceLookup | undefined;
  /**
   * Open a dedicated, network-isolated page for a PDF render. Omitted for
   * runs with no browser; a `pdf` output then fails before any write instead
   * of publishing text under a .pdf name.
   */
  openPdfPage?: (ctx: ToolCtx) => Promise<PdfRenderPage>;
}

/**
 * Build the `write_document` tool for one run.
 *
 * @param deps - the contract and evidence resolvers, plus the optional PDF
 *   page opener
 * @returns the registry definition, ready to append to a registry
 *
 * The executor throws — with every problem named in one message — when the
 * output id is not a document in the current contract, when the run cannot
 * back the citations the document needs, when evidence validation fails, when
 * the format is `pdf` and this run has no page to render in, or when the
 * document renders to nothing. Each of those happens before the first write,
 * so the run directory is untouched. The pipeline turns the throw into a
 * structured error result the model can correct against.
 */
export function createWriteDocumentTool(
  deps: WriteDocumentDeps,
): ToolDef<WriteDocumentInput> {
  return {
    name: WRITE_DOCUMENT_TOOL_NAME,
    description:
      'Publish a required document output (prose) from evidence-marked text. Supply only the ' +
      "contract's outputId and your full text: the filename, format, required sections, how " +
      'much evidence is required, and whether citations are visible all come from the ' +
      'contract. ' +
      `${EVIDENCE_MARKER_SYNTAX} ` +
      'Markers are checked against the run\'s evidence records BEFORE anything is published, ' +
      'and an unknown or missing citation rejects the whole call. The runtime keeps your ' +
      'marked text for review and publishes the reader-facing rendering — with markers ' +
      'removed, or replaced by numbered footnotes with a source list, as the contract ' +
      'requires. Use write_file only for scratch and supporting files, never for a ' +
      'contract document output.',
    inputSchema: writeDocumentInputSchema,
    // Publishes a graded deliverable: the scheduler must serialize it against
    // every other state change.
    readOnly: false,
    async execute(input, ctx): Promise<WriteDocumentResult> {
      const spec = requireDocumentSpec(deps, ctx, input.outputId);
      const lookup = requireLookup(deps, ctx, spec, input.content);

      const validated = validateDocumentEvidence(spec, input.content, lookup);
      if (!validated.ok) {
        throw new Error(
          `${WRITE_DOCUMENT_TOOL_NAME} rejected ${JSON.stringify(spec.id)} and wrote ` +
            `NOTHING. Fix all of these and call ${WRITE_DOCUMENT_TOOL_NAME} again:\n` +
            `${validated.errors.map((error) => `- ${error}`).join('\n')}`,
        );
      }
      // Resolved before rendering so a run that cannot produce a PDF says so
      // instead of writing a source file it will never publish a document for.
      const openPdfPage =
        spec.format === 'pdf' ? requirePdfPageOpener(deps, spec) : undefined;

      const text = renderDocument(spec, validated.document, lookup);
      if (text.trim() === '') {
        throw new Error(
          `${WRITE_DOCUMENT_TOOL_NAME} rejected ${JSON.stringify(spec.id)} and wrote ` +
            `NOTHING: once its evidence markers are removed the document has no text left. ` +
            `Write the prose the task asked for, with markers supporting it rather than ` +
            `standing in for it.`,
        );
      }
      // Everything that can fail happens before the first write: a PDF render
      // is a browser round trip, and a half-published document (marked source
      // on disk, no deliverable) would be worse than no document at all.
      const published =
        openPdfPage === undefined
          ? Buffer.from(text, 'utf8')
          : await renderPdf(spec, validated.document, lookup, {
              openPage: () => openPdfPage(ctx),
            });

      // Classified, not written: the contract's own validation already rejects
      // unsafe filenames, so this only guards against a mis-wired
      // `documentSpecs` dep handing over a hand-built spec. It runs BEFORE the
      // source write, which is what keeps "a rejected call writes nothing"
      // true in that case too — writeArtifact would otherwise catch it one
      // file too late.
      const publishedPath = `${ARTIFACTS_DIR}/${spec.filename}`;
      if (classifyWorkspacePath(ctx.runDir, publishedPath) !== 'artifacts') {
        throw new Error(
          `Document ${JSON.stringify(spec.id)} has filename ${JSON.stringify(spec.filename)}, ` +
            `which does not land under ${ARTIFACTS_DIR}/. Nothing was written.`,
        );
      }

      // Source first: the reviewable input exists before the artifact derived
      // from it. No roles — scratch/ is private working state by construction.
      const sourceEntry = writeArtifact(
        ctx.runDir,
        documentSourcePath(spec.id),
        Buffer.from(validated.document.source, 'utf8'),
      );
      const publishedEntry = writeArtifact(
        ctx.runDir,
        publishedPath,
        published,
        // The deliverable the task asked for, by definition: this tool only
        // ever writes files the contract named.
        { roles: ['requested_output'] },
      );

      return {
        outputId: spec.id,
        publishedPath: publishedEntry.filename,
        publishedSha256: publishedEntry.sha256,
        publishedBytes: published.byteLength,
        format: spec.format,
        evidencePresentation: spec.evidencePresentation,
        sourcePath: sourceEntry.filename,
        sourceSha256: sourceEntry.sha256,
        citedEvidenceIds: [...validated.document.citedEvidenceIds],
      };
    },
  };
}

/** Resolve the contract's document output, or explain which ids exist. A
 * wrong id is the cheapest mistake to make and the cheapest to fix, so the
 * error carries the whole list. */
function requireDocumentSpec(
  deps: WriteDocumentDeps,
  ctx: ToolCtx,
  outputId: string,
): DocumentOutputSpec {
  const specs = deps.documentSpecs(ctx);
  const spec = specs.find((candidate) => candidate.id === outputId);
  if (spec !== undefined) return spec;

  if (specs.length === 0) {
    throw new Error(
      `The current contract requires no document outputs, so ${WRITE_DOCUMENT_TOOL_NAME} ` +
        `has nothing to publish. Publish tabular outputs with their own tool, and use ` +
        `write_file for scratch and supporting files.`,
    );
  }
  throw new Error(
    `No document output ${JSON.stringify(outputId)} in the current contract. ` +
      `Document outputs are: ${specs.map((candidate) => JSON.stringify(candidate.id)).join(', ')}.`,
  );
}

/** Resolve the evidence lookup this document needs.
 *
 * A run with no ledger can still publish a document whose contract requires
 * no evidence AND that cites none — that is the honest reading of
 * `evidenceRequirement: 'none'`. Anything else fails here: publishing
 * citations that nothing can back is exactly the fabrication the ledger
 * exists to prevent. */
function requireLookup(
  deps: WriteDocumentDeps,
  ctx: ToolCtx,
  spec: DocumentOutputSpec,
  content: string,
): DocumentEvidenceLookup {
  const lookup = deps.evidence?.(ctx);
  if (lookup !== undefined) return lookup;

  if (spec.evidenceRequirement !== 'none') {
    throw new Error(
      `Document ${JSON.stringify(spec.id)} requires evidence ` +
        `(${spec.evidenceRequirement}) but this run has no evidence ledger, so no ` +
        `citation can be verified. Nothing was written.`,
    );
  }
  if (parseEvidenceMarkers(content).length > 0) {
    throw new Error(
      `Document ${JSON.stringify(spec.id)} contains evidence markers but this run has ` +
        `no evidence ledger, so they cannot be verified. Remove the markers or record ` +
        `the evidence first. Nothing was written.`,
    );
  }
  // No ledger, no requirement, no markers: every lookup legitimately misses.
  return () => undefined;
}

/** A `pdf` document needs a page to render in. Reported as a run capability,
 * not as the model's mistake — there is nothing about the content it could
 * change to fix this. */
function requirePdfPageOpener(
  deps: WriteDocumentDeps,
  spec: DocumentOutputSpec,
): (ctx: ToolCtx) => Promise<PdfRenderPage> {
  if (deps.openPdfPage !== undefined) return deps.openPdfPage;
  throw new Error(
    `Document ${JSON.stringify(spec.id)} must be published as a PDF, but this run has ` +
      `no browser page to render one in. Nothing was written. Revise the contract to a ` +
      `markdown or text format for this output, or re-run with a browser session.`,
  );
}
