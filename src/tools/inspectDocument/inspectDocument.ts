import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { ContentReaderRegistry, ContentRange } from '../../content/contentReader.js';
import { resolveRunPath } from '../../run/runDir.js';
import { offloadResult, PREVIEW_MAX_BYTES } from '../capResult.js';
import type { ToolDef } from '../registry.js';

// INTEGRATION (primary agent, at cutover):
//  1. Build with createInspectDocumentTool({ registry }) where `registry` is
//     createContentReaderRegistry([...]) over the PDF, spreadsheet, and OCR
//     adapters — and, for OCR, with `persistImage` wired to the run's evidence
//     store so a recognized image is retained.
//  2. Append to the V2 registry after read_resource.
//  3. read_resource and observe should route non-HTML bytes through the same
//     registry instance, so a PDF found by either path reads identically.

/**
 * `inspect_document`: read a bounded slice of a non-HTML document already in
 * the run directory.
 *
 * The path is the model's, so it is resolved through `resolveRunPath` and can
 * never escape the run. The FORMAT, by contrast, is not the model's to
 * declare: it is detected from the bytes, so a file whose name lies about its
 * type is still read correctly (see contentReader's detection rules).
 */
export const inspectDocumentInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe('Run-directory-relative path of the document to read, e.g. "artifacts/filing.pdf".'),
    from: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First page / row / image to read, 1-based. Defaults to the start.'),
    to: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Last page / row / image to read, inclusive. Bounded by a per-format ceiling.'),
  })
  .strict();

export type InspectDocumentInput = z.infer<typeof inspectDocumentInputSchema>;

/** What the model receives. */
export interface InspectDocumentResult {
  format: string;
  /** Where this slice came from: `pages 1-5`, `Sheet1!1-50`, `image 2`. */
  locator: string;
  /** The slice's text, or a preview plus offload path when it is large. */
  text?: string;
  preview?: string;
  offloadedTo?: string;
  note?: string;
  /** The range that continues this read, when more remains. */
  continuation?: ContentRange;
  /** Total pages / rows / images, when known. */
  total?: number;
  /** Format-specific provenance: page lines and boxes, cell addresses with
   * displayed vs underlying values, OCR engine and confidence. */
  metadata?: Record<string, unknown>;
}

/** What the tool needs from the run. */
export interface InspectDocumentDeps {
  registry: ContentReaderRegistry;
  /** Byte ceiling for inline text before it is offloaded; defaults to a
   * conservative slice of the per-result cap so the provenance metadata
   * always fits alongside it. */
  maxInlineTextBytes?: number;
}

const DEFAULT_MAX_INLINE_TEXT_BYTES = 20_000;

/**
 * Create the tool.
 *
 * Not read-only in the strict sense — OCR and PDF parsing consume real CPU
 * and the adapters may persist source images as evidence — but it mutates no
 * page and no output, so it is safe to run alongside other reads.
 */
export function createInspectDocumentTool(deps: InspectDocumentDeps): ToolDef<InspectDocumentInput> {
  const maxInlineTextBytes = deps.maxInlineTextBytes ?? DEFAULT_MAX_INLINE_TEXT_BYTES;
  if (!Number.isInteger(maxInlineTextBytes) || maxInlineTextBytes <= PREVIEW_MAX_BYTES) {
    throw new Error(
      `maxInlineTextBytes must be an integer > ${PREVIEW_MAX_BYTES}, got ${maxInlineTextBytes}`,
    );
  }

  return {
    name: 'inspect_document',
    description:
      'Read a bounded slice of a PDF, spreadsheet, or image already saved in the run ' +
      'directory, with the provenance needed to cite it: PDF page and line positions, exact ' +
      'spreadsheet cell addresses with both displayed and underlying values, or OCR text with ' +
      'its engine and confidence. The format is detected from the file\'s bytes, not its name. ' +
      'Large documents return one slice plus the range that continues it — ask for the next ' +
      'range rather than expecting everything at once. OCR text is never exact: check the ' +
      'reported confidence before using a recognized number or name as a final value.',
    inputSchema: inspectDocumentInputSchema,
    readOnly: true,
    execute: async (input, ctx): Promise<InspectDocumentResult> => {
      // The model supplies this path, so confinement is not optional.
      const absPath = resolveRunPath(ctx.runDir, input.path);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(absPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new Error(`File does not exist: ${input.path}`);
        if (code === 'EISDIR') throw new Error(`Path is a directory, not a file: ${input.path}`);
        throw error;
      }

      const range =
        input.from === undefined && input.to === undefined
          ? undefined
          : { from: input.from ?? 1, to: input.to ?? input.from ?? 1 };

      const observation = await deps.registry.read({
        bytes,
        filename: input.path,
        ...(range === undefined ? {} : { range }),
      });

      const base: InspectDocumentResult = {
        format: observation.format,
        locator: observation.locator,
        ...(observation.continuation === undefined
          ? {}
          : { continuation: observation.continuation }),
        ...(observation.total === undefined ? {} : { total: observation.total }),
        ...(observation.metadata === undefined ? {} : { metadata: observation.metadata }),
      };

      // Text is offloaded rather than truncated: a silently cut page would
      // make the model reason about half a document as though it were whole.
      if (Buffer.byteLength(observation.text, 'utf8') <= maxInlineTextBytes) {
        return { ...base, text: observation.text };
      }
      const offloaded = offloadResult(
        ctx.runDir,
        'inspect_document',
        observation.text,
        `over this tool's ${maxInlineTextBytes}-byte inline limit`,
      );
      return {
        ...base,
        preview: offloaded.preview,
        offloadedTo: offloaded.offloadedTo,
        note: offloaded.note,
      };
    },
  };
}
