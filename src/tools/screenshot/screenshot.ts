import { z } from 'zod';

import {
  matchesFilenamePattern,
  type OutputContract,
  type OutputSpec,
} from '../../contracts/outputContract.js';
import { writeArtifact } from '../../run/artifacts.js';
import type { ToolDef } from '../registry.js';
import { requireBrowser } from '../shared/browser.js';
import { artifactRolesInput, assertEvidencePath, type EvidenceResult } from '../shared/evidence.js';
import { accessKey } from '../registry.js';

const screenshotInputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .describe('Run-directory-relative path for the PNG evidence file, under artifacts/'),
    fullPage: z
      .boolean()
      .optional()
      .describe('Capture the whole scrollable page instead of the viewport'),
    pageId: z
      .string()
      .min(1)
      .optional()
      .describe('Page to capture, from an observe result; omit for the selected page'),
    roles: artifactRolesInput.describe(
      'Roles recorded for the capture. Omit this: the runtime derives it from the ' +
        'output contract, marking the capture a requested_output when the contract ' +
        'declares screenshots and plain evidence when it does not.',
    ),
  })
  .strict();

/** Input accepted by the screenshot tool. */
export type ScreenshotInput = z.infer<typeof screenshotInputSchema>;

/** What the screenshot tool needs from the run. */
export interface ScreenshotToolDeps {
  /** The run's current contract, read PER CALL so a contract revision applies
   * to the very next capture rather than to the next run. */
  contract: () => OutputContract | undefined;
}

type ScreenshotSpec = Extract<OutputSpec, { kind: 'screenshots' }>;

/** The bare filename, for pattern matching (patterns describe names, not paths). */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Build the `screenshot` tool over one run's contract.
 *
 * A factory rather than a static definition because it consults the contract,
 * which is run-scoped state. Two things that used to be settled long after the
 * fact are now settled at capture time:
 *
 * 1. **The filename.** When the contract declares a `filenamePattern`, a
 *    mismatch used to surface only in the submission checks — after the run had
 *    already taken every capture under the wrong name, with no way to rename a
 *    published artifact. Rejecting here costs one turn instead.
 * 2. **The roles.** `roles` was model-supplied and unchecked, so a capture was
 *    recorded as a `requested_output` on the model's word alone — and graders
 *    select deliverables from exactly those entries. The contract knows whether
 *    screenshots are a deliverable, so the runtime derives roles from it. A
 *    model-supplied `requested_output` that the contract does not support is
 *    refused rather than quietly written into the provenance record.
 */
export function createScreenshotTool(deps: ScreenshotToolDeps): ToolDef<ScreenshotInput> {
  return {
    name: 'screenshot',
    description:
      'Capture a page as PNG evidence, published under artifacts/ in the run directory. ' +
      'Captures the viewport by default; set fullPage to capture the entire scrollable page. ' +
      'Set pageId to capture a specific page (from an observe result); omit it to capture the ' +
      'selected page. When the contract declares screenshots with a filename pattern, the ' +
      'filename must match it. Returns the artifact path and byte size.',
    inputSchema: screenshotInputSchema,
    // Reads the named page (the selected one by default), writes a file and
    // the manifest — so two screenshots of the SAME page serialize, but a
    // screenshot of page p1 and one of page p2 do not, and neither serializes
    // against an unrelated table update. Keying by input.pageId here (rather
    // than the fixed accessKey.selectedPage()) is what makes that true: a
    // fixed key would wrongly collide two calls naming different pages, and
    // wrongly fail to collide a named-page call with concurrent work on the
    // task tab.
    getAccess: (input) => ({
      reads: [accessKey.page(input.pageId ?? 'selected')],
      writes: [accessKey.file(input.filename), accessKey.manifest()],
    }),
    async execute(input, ctx): Promise<EvidenceResult> {
      const browser = requireBrowser(ctx);
      assertEvidencePath(ctx.runDir, input.filename);

      const specs = (deps.contract()?.outputs ?? []).filter(
        (output): output is ScreenshotSpec => output.kind === 'screenshots',
      );
      const roles = resolveRoles(input, specs);

      const sourceUrl = browser.currentUrl(input.pageId);
      const bytes = await browser.screenshot({
        fullPage: input.fullPage ?? false,
        ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      });
      const entry = writeArtifact(ctx.runDir, input.filename, bytes, { sourceUrl, roles });
      return { path: entry.filename, size: bytes.byteLength };
    },
  };
}

/**
 * Check the filename against the contract and decide the capture's roles.
 *
 * @throws when a declared `filenamePattern` rules the filename out, or when the
 *   caller claims `requested_output` for a run whose contract asks for no
 *   screenshots at all
 */
function resolveRoles(
  input: ScreenshotInput,
  specs: readonly ScreenshotSpec[],
): NonNullable<ScreenshotInput['roles']> {
  // Only reject on a pattern when EVERY declared screenshots output has one and
  // none accept this name. A contract may also declare screenshots with no
  // pattern, and this capture could legitimately belong to that one.
  const patterns = specs.map((spec) => spec.filenamePattern);
  if (specs.length > 0 && patterns.every((pattern) => pattern !== undefined)) {
    const base = baseName(input.filename);
    if (!patterns.some((pattern) => matchesFilenamePattern(base, pattern!))) {
      throw new Error(
        `${input.filename} does not match the filename pattern the contract requires for ` +
          `screenshots (${patterns.map((pattern) => `"${pattern!}"`).join(' or ')}). ` +
          'Capture it under a matching name — a published artifact cannot be renamed later.',
      );
    }
  }

  if (specs.length === 0) {
    if (input.roles?.includes('requested_output') === true) {
      throw new Error(
        'This run\'s contract declares no screenshots output, so a capture cannot be a ' +
          'requested_output. Omit roles to record it as evidence, or revise the contract with ' +
          'set_output_contract first if the task really does ask for a screenshot.',
      );
    }
    return ['evidence'];
  }

  // The contract asks for screenshots, so a capture is a deliverable as well as
  // evidence. Derived rather than taken from the model: graders select
  // deliverables from exactly these entries, and a self-reported role is a
  // claim nothing checks.
  return input.roles ?? ['requested_output', 'evidence'];
}
