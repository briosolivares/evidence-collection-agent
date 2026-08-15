import { basename, relative, resolve, sep } from 'node:path';

import {
  matchesFilenamePattern,
  type OutputContract,
  type OutputSpec,
} from '../../contracts/outputContract.js';
import { ARTIFACTS_DIR, type ManifestEntry } from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import type { FinishInput } from '../tools/finish.js';
import {
  artifactBasename,
  decodeUtf8,
  hasRole,
  inferMediaTypes,
  inspectManifest,
  isPng,
  type InspectedEntry,
  V3_FINISH_SIGNATURE_BYTES,
} from './artifactInspection.js';
import { findPlaceholder, inspectTable } from './tableInspection.js';
import type {
  V3CaptureFact,
  V3DocumentFact,
  V3FinishCheckResult,
  V3FinishDefect,
  V3FinishFacts,
  V3SettledFact,
} from './types.js';

export type {
  V3CaptureFact,
  V3DocumentFact,
  V3FinishCheckResult,
  V3FinishDefect,
  V3FinishFacts,
  V3ManifestFacts,
  V3OutputFact,
  V3SettledFact,
  V3TableFact,
} from './types.js';
export { v3FinishFactsSchema } from './types.js';

export interface RunV3FinishChecksInput {
  runDir: string;
  /** The initializer-authored contract. This function never mutates it. */
  contract: OutputContract;
  /** The already schema-validated exclusive `finish` control input. */
  finish: FinishInput;
  /** Trusted run cancellation/deadline guard; throws to stop inspection. */
  checkActive?: () => void;
}

type VerifiedContentEntry = InspectedEntry & {
  byteLength: number;
  contentPrefix: Uint8Array;
};

/**
 * Settle every generic, objective completion property before invoking a
 * verifier. The function is read-only: it does not render files, revise the
 * contract, alter manifest roles, or depend on the retired row/evidence
 * stores.
 */
export function runV3FinishChecks({
  runDir,
  contract,
  finish,
  checkActive,
}: RunV3FinishChecksInput): V3FinishCheckResult {
  checkActive?.();
  const defects: V3FinishDefect[] = [];
  const facts: V3FinishFacts = {
    finish: {
      summary: finish.summary,
      artifactPaths: [...finish.artifacts],
      limitations: [...finish.limitations],
    },
    outputs: [],
    evidenceScreenshotPaths: [],
  };

  validateFinishText(finish, defects);
  const fixedPaths = new Set(
    contract.outputs.flatMap((output) =>
      output.kind === 'table' || output.kind === 'document'
        ? [`${ARTIFACTS_DIR}/${output.filename}`]
        : [],
    ),
  );
  const inspection = inspectManifest(runDir, {
    publishedPrefixBytes: V3_FINISH_SIGNATURE_BYTES,
    retainPublishedBytes: (entry, artifactPath) =>
      finishChecksNeedFullBytes(contract, entry, artifactPath),
    ...(checkActive === undefined ? {} : { checkActive }),
  });
  checkActive?.();
  defects.push(...inspection.defects);

  if (inspection.manifest === undefined) return failed(defects, facts);

  const requestedEntries = inspection.entries.filter(
    (entry) =>
      entry.canonicalPath.startsWith(`${ARTIFACTS_DIR}/`) &&
      hasRole(entry, 'requested_output'),
  );
  const evidenceEntries = inspection.entries.filter(
    (entry) =>
      entry.canonicalPath.startsWith(`${ARTIFACTS_DIR}/`) && hasRole(entry, 'evidence'),
  );
  const browserProvider =
    inspection.manifest.browserProvider === 'local' ||
    inspection.manifest.browserProvider === 'browserbase'
      ? inspection.manifest.browserProvider
      : undefined;
  facts.manifest = {
    task: inspection.manifest.task,
    ...(browserProvider === undefined ? {} : { browserProvider }),
    entryCount: inspection.entries.length,
    verifiedPaths: inspection.entries
      .filter((entry) => entry.integrityVerified)
      .map((entry) => entry.canonicalPath),
    requestedOutputPaths: requestedEntries.map((entry) => entry.canonicalPath),
    evidencePaths: evidenceEntries.map((entry) => entry.canonicalPath),
  };

  const entriesByPath = new Map<string, InspectedEntry>();
  for (const entry of inspection.entries) {
    if (!entriesByPath.has(entry.canonicalPath)) {
      entriesByPath.set(entry.canonicalPath, entry);
    }
  }

  validateFinishArtifactClaims(
    runDir,
    finish,
    entriesByPath,
    requestedEntries,
    defects,
  );

  const claimedContractPaths = new Set<string>();
  const captureOwners = new Map<string, string[]>();

  for (const output of contract.outputs) {
    checkActive?.();
    if (output.kind === 'table') {
      const artifactPath = `${ARTIFACTS_DIR}/${output.filename}`;
      claimedContractPaths.add(artifactPath);
      const entry = requireRequestedOutput(output, artifactPath, entriesByPath, defects);
      if (entry?.bytes === undefined || !entry.integrityVerified) continue;
      const outcome = inspectTable(
        output,
        artifactPath,
        entry.bytes,
        checkActive === undefined ? {} : { checkActive },
      );
      checkActive?.();
      defects.push(...outcome.defects);
      if (outcome.fact !== undefined) facts.outputs.push(outcome.fact);
      continue;
    }

    if (output.kind === 'document') {
      const artifactPath = `${ARTIFACTS_DIR}/${output.filename}`;
      claimedContractPaths.add(artifactPath);
      const entry = requireRequestedOutput(output, artifactPath, entriesByPath, defects);
      if (entry === undefined || !entry.integrityVerified) continue;
      const content = output.format === 'pdf' ? inspectionBytes(entry) : entry.bytes;
      if (content === undefined || entry.byteLength === undefined) continue;
      const outcome = inspectDocument(output, artifactPath, content, entry.byteLength);
      defects.push(...outcome.defects);
      if (outcome.fact !== undefined) facts.outputs.push(outcome.fact);
      continue;
    }

    const outcome = inspectCaptureOutput(
      output,
      inspection.entries.filter(
        (entry): entry is VerifiedContentEntry =>
          entry.canonicalPath.startsWith(`${ARTIFACTS_DIR}/`) &&
          !fixedPaths.has(entry.canonicalPath) &&
          entry.integrityVerified &&
          entry.byteLength !== undefined &&
          entry.contentPrefix !== undefined,
      ),
    );
    defects.push(...outcome.defects);
    facts.outputs.push(outcome.fact);
    for (const path of outcome.attemptedPaths) claimedContractPaths.add(path);
    for (const path of outcome.validPaths) {
      const owners = captureOwners.get(path) ?? [];
      owners.push(output.id);
      captureOwners.set(path, owners);
    }
  }

  for (const [artifactPath, owners] of captureOwners) {
    checkActive?.();
    if (owners.length > 1) {
      defects.push({
        code: 'ambiguous_capture_assignment',
        artifactPath,
        message:
          `${artifactPath} satisfies multiple capture outputs (${owners.join(', ')}). ` +
          'Use non-overlapping filename patterns so each requested capture satisfies exactly one contract output.',
      });
    }
  }

  for (const entry of requestedEntries) {
    checkActive?.();
    if (!claimedContractPaths.has(entry.canonicalPath)) {
      defects.push({
        code: 'unexpected_requested_output',
        artifactPath: entry.canonicalPath,
        message:
          `${entry.canonicalPath} carries requested_output but is not required by the immutable output contract. ` +
          'Re-publish supporting material as evidence-only, or remove the stray requested-output publication.',
      });
    }
  }

  for (const entry of requestedEntries) {
    checkActive?.();
    if (
      entry.canonicalPath.startsWith(`${ARTIFACTS_DIR}/helper-proposals/`) &&
      !claimedContractPaths.has(entry.canonicalPath)
    ) {
      defects.push({
        code: 'helper_proposal_wrong_role',
        artifactPath: entry.canonicalPath,
        message: `${entry.canonicalPath} is a helper proposal, so it must be evidence-only unless the contract explicitly requests it.`,
      });
    }
  }

  const evidenceScreenshots = evidenceEntries.filter(
    (entry) =>
      entry.integrityVerified &&
      isPng(inspectionBytes(entry)) &&
      (entry.byteLength ?? 0) > 0 &&
      hasSource(entry),
  );
  checkActive?.();
  facts.evidenceScreenshotPaths = evidenceScreenshots.map(
    (entry) => entry.canonicalPath,
  );

  if (
    browserProvider !== undefined &&
    evidenceScreenshots.length === 0 &&
    !taskExplicitlyForbidsScreenshots(inspection.manifest.task) &&
    !finish.limitations.some(isExplicitScreenshotAccessLimitation)
  ) {
    defects.push({
      code: 'missing_browser_evidence_screenshot',
      message:
        'This browser-backed run has no verified evidence-role PNG with source provenance. ' +
        'Publish a useful final/source screenshot, or explicitly report the access constraint that made capture impossible.',
    });
  }

  const documentNeedsEvidence = contract.outputs.some(
    (output) => output.kind === 'document' && output.evidenceRequirement !== 'none',
  );
  if (
    documentNeedsEvidence &&
    !evidenceEntries.some((entry) => entry.integrityVerified)
  ) {
    defects.push({
      code: 'missing_document_evidence',
      message:
        'At least one requested document requires evidence, but the manifest contains no verified evidence-role artifact. Publish supporting evidence before finishing.',
    });
  }

  return defects.length === 0
    ? { status: 'passed', defects: [], facts }
    : failed(defects, facts);
}

/**
 * Convert passed structured facts to the verifier's compact settled-fact
 * protocol. The structured form remains checkpoint-friendly; this view lets
 * the preserved verifier consume it without re-reading counts or hashes.
 */
export function toV3SettledFacts(facts: V3FinishFacts): V3SettledFact[] {
  const settled: V3SettledFact[] = [];
  if (facts.manifest !== undefined) {
    settled.push({
      code: 'manifest_integrity',
      statement:
        `All ${facts.manifest.verifiedPaths.length} recorded file(s) named here were opened as ` +
        'regular non-symlink files and matched their manifest SHA-256 values.',
    });
  }
  for (const output of facts.outputs) {
    switch (output.kind) {
      case 'table':
        settled.push({
          outputId: output.outputId,
          code: 'table_shape',
          statement:
            `${output.artifactPath} parsed as ${output.format} with exactly ${output.rowCount} ` +
            `data row(s) and columns [${output.columns.join(', ')}] in the required order. ` +
            `Every declared rule passed (${output.satisfiedRules.join(', ') || 'none declared'}).`,
        });
        break;
      case 'document':
        settled.push({
          outputId: output.outputId,
          code: 'document_shape',
          statement:
            `${output.artifactPath} is a non-empty ${output.format} document (${output.byteLength} ` +
            `bytes) and contains every mechanically required section ` +
            `[${output.requiredSectionsPresent.join(', ')}].`,
        });
        break;
      case 'screenshots':
      case 'download':
        settled.push({
          outputId: output.outputId,
          code: `${output.kind}_shape`,
          statement:
            `${output.count} valid requested ${output.kind === 'screenshots' ? 'screenshot' : 'download'} ` +
            `artifact(s) satisfied the contract: [${output.artifactPaths.join(', ')}]. Their ` +
            'recorded source URLs and inferred byte formats passed deterministic checks.',
        });
        break;
    }
  }
  if (facts.evidenceScreenshotPaths.length > 0) {
    settled.push({
      code: 'evidence_screenshots',
      statement:
        `Verified source-backed evidence screenshot(s): ` +
        `[${facts.evidenceScreenshotPaths.join(', ')}].`,
    });
  }
  return settled;
}

function finishChecksNeedFullBytes(
  contract: OutputContract,
  entry: ManifestEntry,
  artifactPath: string,
): boolean {
  for (const output of contract.outputs) {
    if (output.kind === 'table') {
      if (artifactPath === `${ARTIFACTS_DIR}/${output.filename}`) return true;
      continue;
    }
    if (output.kind === 'document') {
      if (
        output.format !== 'pdf' &&
        artifactPath === `${ARTIFACTS_DIR}/${output.filename}`
      ) {
        return true;
      }
      continue;
    }
    if (output.kind !== 'download') continue;
    if (
      output.filenamePattern !== undefined &&
      matchesFilenamePattern(basename(artifactPath), output.filenamePattern)
    ) {
      return true;
    }
    if (output.filenamePattern === undefined && output.allowedMediaTypes !== undefined) {
      return true;
    }
    if (
      output.filenamePattern === undefined &&
      output.sourceUrlPattern !== undefined &&
      entry.sourceUrl !== undefined &&
      matchesFilenamePattern(entry.sourceUrl, output.sourceUrlPattern)
    ) {
      return true;
    }
  }
  return false;
}

function inspectionBytes(entry: VerifiedContentEntry): Uint8Array;
function inspectionBytes(entry: InspectedEntry): Uint8Array | undefined;
function inspectionBytes(entry: InspectedEntry): Uint8Array | undefined {
  return entry.bytes ?? entry.contentPrefix;
}

function validateFinishText(finish: FinishInput, defects: V3FinishDefect[]): void {
  const summaryPlaceholder = findPlaceholder(finish.summary);
  if (summaryPlaceholder !== undefined) {
    defects.push({
      code: 'placeholder_finish_summary',
      message: `finish.summary contains unfinished placeholder text (${JSON.stringify(summaryPlaceholder)}). Replace it with the actual user-facing result.`,
    });
  }
  for (const [index, limitation] of finish.limitations.entries()) {
    const placeholder = findPlaceholder(limitation);
    if (placeholder !== undefined) {
      defects.push({
        code: 'placeholder_limitation',
        message: `finish.limitations[${index}] contains unfinished placeholder text (${JSON.stringify(placeholder)}). State the concrete unresolved constraint or remove it.`,
      });
    }
  }
  if (finish.artifacts.length === 0 && finish.limitations.length === 0) {
    defects.push({
      code: 'empty_finish_claim',
      message:
        'finish names no completed artifact and no limitation. Publish the required outputs, or state the concrete source/access/freshness constraint blocking them.',
    });
  }
}

function validateFinishArtifactClaims(
  runDir: string,
  finish: FinishInput,
  entriesByPath: ReadonlyMap<string, InspectedEntry>,
  requestedEntries: readonly InspectedEntry[],
  defects: V3FinishDefect[],
): Set<string> {
  const finishPaths = new Set<string>();
  for (const supplied of finish.artifacts) {
    const canonical = canonicalFinishPath(runDir, supplied);
    if ('defect' in canonical) {
      defects.push(canonical.defect);
      continue;
    }
    const artifactPath = canonical.path;
    if (finishPaths.has(artifactPath)) {
      defects.push({
        code: 'duplicate_finish_artifact',
        artifactPath,
        message: `finish.artifacts lists ${artifactPath} more than once. List each requested output exactly once.`,
      });
      continue;
    }
    finishPaths.add(artifactPath);
    const entry = entriesByPath.get(artifactPath);
    if (entry === undefined) {
      defects.push({
        code: 'finish_artifact_not_manifested',
        artifactPath,
        message: `${artifactPath} is listed in finish but has no manifest entry. Publish it through publish_artifact before finishing.`,
      });
      continue;
    }
    if (!hasRole(entry, 'requested_output')) {
      defects.push({
        code: 'finish_artifact_not_requested_output',
        artifactPath,
        message: `${artifactPath} is listed in finish but does not carry the requested_output role. Re-publish it with the correct role or remove it from finish.`,
      });
    }
    if (entry.entry.completionStatus === 'partial') {
      defects.push({
        code: 'partial_finish_artifact',
        artifactPath,
        message: `${artifactPath} is marked partial and cannot be claimed complete in finish.`,
      });
    }
  }

  for (const entry of requestedEntries) {
    if (!finishPaths.has(entry.canonicalPath)) {
      defects.push({
        code: 'finish_omits_requested_output',
        artifactPath: entry.canonicalPath,
        message: `finish.artifacts omits manifested requested output ${entry.canonicalPath}. List every completed requested output exactly as recorded.`,
      });
    }
  }
  return finishPaths;
}

function canonicalFinishPath(
  runDir: string,
  supplied: string,
): { path: string } | { defect: V3FinishDefect } {
  let absolute: string;
  try {
    absolute = resolveRunPath(runDir, supplied);
  } catch {
    return {
      defect: {
        code: 'unsafe_finish_artifact_path',
        artifactPath: supplied,
        message: `finish artifact ${JSON.stringify(supplied)} escapes the run directory. Use its canonical artifacts/ path.`,
      },
    };
  }
  const normalized = relative(resolve(runDir), absolute).split(sep).join('/');
  if (normalized !== supplied.split(sep).join('/') || !normalized.startsWith(`${ARTIFACTS_DIR}/`)) {
    return {
      defect: {
        code: 'noncanonical_finish_artifact_path',
        artifactPath: supplied,
        message: `finish artifact ${JSON.stringify(supplied)} must be a canonical run-relative path under artifacts/ (for example ${JSON.stringify(normalized)}).`,
      },
    };
  }
  return { path: normalized };
}

function requireRequestedOutput(
  output: Extract<OutputSpec, { kind: 'table' | 'document' }>,
  artifactPath: string,
  entriesByPath: ReadonlyMap<string, InspectedEntry>,
  defects: V3FinishDefect[],
): InspectedEntry | undefined {
  const entry = entriesByPath.get(artifactPath);
  if (entry === undefined) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'missing_required_output',
      message: `Required ${output.kind} ${artifactPath} is absent from the manifest. Publish that exact filename with requested_output.`,
    });
    return undefined;
  }
  if (!hasRole(entry, 'requested_output')) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'required_output_wrong_role',
      message: `${artifactPath} exists but lacks requested_output. Re-publish the exact file with the required role.`,
    });
  }
  if (entry.entry.completionStatus === 'partial') {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'required_output_partial',
      message: `${artifactPath} is marked partial and does not satisfy the required ${output.kind} output.`,
    });
  }
  if (entry.byteLength === 0) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'empty_output',
      message: `${artifactPath} is empty. Publish the completed ${output.kind} content.`,
    });
  }
  return entry;
}

function inspectDocument(
  output: Extract<OutputSpec, { kind: 'document' }>,
  artifactPath: string,
  bytes: Uint8Array,
  byteLength: number,
): { defects: V3FinishDefect[]; fact?: V3DocumentFact } {
  const defects: V3FinishDefect[] = [];
  if (byteLength === 0) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'empty_output',
      message: `${artifactPath} is empty. Publish the completed document.`,
    });
    return { defects };
  }

  if (output.format === 'pdf') {
    if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) {
      defects.push({
        outputId: output.id,
        artifactPath,
        code: 'document_format_mismatch',
        message: `${artifactPath} is declared as PDF but does not begin with the PDF file signature.`,
      });
      return { defects };
    }
    return {
      defects: [],
      fact: {
        kind: 'document',
        outputId: output.id,
        artifactPath,
        format: output.format,
        byteLength,
        requiredSectionsPresent: [],
      },
    };
  }

  const text = decodeUtf8(bytes);
  if (text === undefined) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'invalid_text_encoding',
      message: `${artifactPath} is not valid UTF-8 ${output.format} text.`,
    });
    return { defects };
  }
  if (text.trim().length === 0) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'empty_output',
      message: `${artifactPath} contains only whitespace. Publish substantive document content.`,
    });
  }
  const placeholder = findPlaceholder(text);
  if (placeholder !== undefined) {
    defects.push({
      outputId: output.id,
      artifactPath,
      code: 'placeholder_text',
      message: `${artifactPath} still contains unfinished placeholder text (${JSON.stringify(placeholder)}).`,
    });
  }
  const present: string[] = [];
  for (const section of output.requiredSections ?? []) {
    if (text.includes(section)) {
      present.push(section);
    } else {
      defects.push({
        outputId: output.id,
        artifactPath,
        code: 'missing_required_section',
        message: `${artifactPath} is missing required section ${JSON.stringify(section)}.`,
      });
    }
  }
  return defects.length === 0
    ? {
        defects: [],
        fact: {
          kind: 'document',
          outputId: output.id,
          artifactPath,
          format: output.format,
          byteLength,
          requiredSectionsPresent: present,
        },
      }
    : { defects };
}

function inspectCaptureOutput(
  output: Extract<OutputSpec, { kind: 'screenshots' | 'download' }>,
  candidates: readonly VerifiedContentEntry[],
): {
  defects: V3FinishDefect[];
  fact: V3CaptureFact;
  attemptedPaths: string[];
  validPaths: string[];
} {
  const patternMatches = candidates.filter((entry) => {
    if (output.filenamePattern !== undefined) {
      return matchesFilenamePattern(artifactBasename(entry), output.filenamePattern);
    }
    if (output.kind === 'screenshots') return isPng(inspectionBytes(entry));

    // A download contract without a filename pattern is still required by
    // contract validation to constrain media type or source URL. Use those
    // positive constraints to avoid treating an unrelated requested
    // screenshot as a malformed download (or vice versa).
    const mediaMatches =
      output.allowedMediaTypes?.some((allowed) => {
        if (allowed.toLowerCase() === 'application/octet-stream') return true;
        return inferMediaTypes(inspectionBytes(entry), artifactBasename(entry)).some(
          (actual) => actual.toLowerCase() === allowed.toLowerCase(),
        );
      }) ?? false;
    const sourceMatches =
      output.sourceUrlPattern !== undefined &&
      entry.entry.sourceUrl !== undefined &&
      matchesFilenamePattern(entry.entry.sourceUrl, output.sourceUrlPattern);
    return mediaMatches || sourceMatches;
  });
  const defects: V3FinishDefect[] = [];
  const valid: Array<{ entry: VerifiedContentEntry; sourceUrl: string }> = [];

  for (const entry of patternMatches) {
    const bytes = inspectionBytes(entry);
    const sourceUrl = hasSource(entry) ? entry.entry.sourceUrl : undefined;
    let acceptable = true;
    if (!hasRole(entry, 'requested_output')) {
      defects.push(
        captureDefect(
          output,
          entry,
          'capture_wrong_role',
          `${entry.canonicalPath} matches required ${output.kind} output ${output.id} but lacks requested_output. Re-publish it with requested_output (and evidence too when it supports the run).`,
        ),
      );
      acceptable = false;
    }
    if (entry.byteLength === 0) {
      defects.push(captureDefect(output, entry, 'empty_capture', `${entry.canonicalPath} is empty.`));
      acceptable = false;
    }
    if (!hasSource(entry)) {
      defects.push(
        captureDefect(
          output,
          entry,
          'missing_capture_source_url',
          `${entry.canonicalPath} has no source URL. Re-publish the browser capture so its origin is auditable.`,
        ),
      );
      acceptable = false;
    }

    if (output.kind === 'screenshots') {
      if (!isPng(bytes)) {
        defects.push(
          captureDefect(
            output,
            entry,
            'screenshot_format_mismatch',
            `${entry.canonicalPath} matches the requested screenshot name but is not PNG screenshot bytes.`,
          ),
        );
        acceptable = false;
      }
    } else {
      if (entry.bytes === undefined) {
        defects.push(
          captureDefect(
            output,
            entry,
            'capture_content_not_inspected',
            `${entry.canonicalPath} could not be retained within the bounded deterministic content-inspection budget. Reduce or split it before finishing.`,
          ),
        );
        acceptable = false;
      }
      if (
        output.sourceUrlPattern !== undefined &&
        entry.entry.sourceUrl !== undefined &&
        !matchesFilenamePattern(entry.entry.sourceUrl, output.sourceUrlPattern)
      ) {
        defects.push(
          captureDefect(
            output,
            entry,
            'download_source_mismatch',
            `${entry.canonicalPath} source URL ${JSON.stringify(entry.entry.sourceUrl)} does not match ${JSON.stringify(output.sourceUrlPattern)}.`,
          ),
        );
        acceptable = false;
      }
      const inferred = inferMediaTypes(bytes, artifactBasename(entry));
      if (
        output.allowedMediaTypes !== undefined &&
        !output.allowedMediaTypes.some(
          (allowed) => allowed.toLowerCase() === 'application/octet-stream',
        ) &&
        !output.allowedMediaTypes.some((allowed) =>
          inferred.some((actual) => actual.toLowerCase() === allowed.toLowerCase()),
        )
      ) {
        defects.push(
          captureDefect(
            output,
            entry,
            'download_media_type_mismatch',
            `${entry.canonicalPath} has inferred media type(s) [${inferred.join(', ')}], not one of [${output.allowedMediaTypes.join(', ')}].`,
          ),
        );
        acceptable = false;
      }
      const text = entry.bytes === undefined ? undefined : decodeUtf8(entry.bytes);
      const placeholder = text === undefined ? undefined : findPlaceholder(text);
      if (placeholder !== undefined) {
        defects.push(
          captureDefect(
            output,
            entry,
            'placeholder_text',
            `${entry.canonicalPath} still contains unfinished placeholder text (${JSON.stringify(placeholder)}).`,
          ),
        );
        acceptable = false;
      }
    }
    if (acceptable && sourceUrl !== undefined) valid.push({ entry, sourceUrl });
  }

  const countDefect = validateCaptureCount(output, valid.length);
  if (countDefect !== undefined) defects.push(countDefect);
  return {
    defects,
    fact: {
      kind: output.kind,
      outputId: output.id,
      artifactPaths: valid.map(({ entry }) => entry.canonicalPath),
      count: valid.length,
      ...(output.filenamePattern === undefined
        ? {}
        : { filenamePattern: output.filenamePattern }),
      inferredMediaTypes: valid.map(({ entry }) =>
        inferMediaTypes(inspectionBytes(entry), artifactBasename(entry)),
      ),
      sourceUrls: valid.map(({ sourceUrl }) => sourceUrl),
    },
    attemptedPaths: patternMatches.map((entry) => entry.canonicalPath),
    validPaths: valid.map(({ entry }) => entry.canonicalPath),
  };
}

function validateCaptureCount(
  output: Extract<OutputSpec, { kind: 'screenshots' | 'download' }>,
  actual: number,
): V3FinishDefect | undefined {
  const noun = output.kind === 'screenshots' ? 'screenshot' : 'download';
  const described =
    output.filenamePattern === undefined
      ? ''
      : ` matching ${JSON.stringify(output.filenamePattern)}`;
  if ('exact' in output.count && actual !== output.count.exact) {
    return {
      outputId: output.id,
      code: 'capture_count_mismatch',
      message: `The run has ${actual} valid requested ${noun}(s)${described}; the contract requires exactly ${output.count.exact}.`,
    };
  }
  if ('minimum' in output.count && actual < output.count.minimum) {
    return {
      outputId: output.id,
      code: 'capture_count_below_minimum',
      message: `The run has ${actual} valid requested ${noun}(s)${described}; the contract requires at least ${output.count.minimum}.`,
    };
  }
  return undefined;
}

function captureDefect(
  output: Extract<OutputSpec, { kind: 'screenshots' | 'download' }>,
  entry: InspectedEntry,
  code: string,
  message: string,
): V3FinishDefect {
  return { code, message, outputId: output.id, artifactPath: entry.canonicalPath };
}

function hasSource(entry: InspectedEntry): boolean {
  return (entry.entry.sourceUrl?.trim().length ?? 0) > 0;
}

function taskExplicitlyForbidsScreenshots(task: string): boolean {
  return /(?:without|no|do not (?:take|include|capture|provide))\s+(?:any\s+)?screenshots?/i.test(
    task,
  );
}

function isExplicitScreenshotAccessLimitation(limitation: string): boolean {
  return (
    /(?:access|blocked|unavailable|unable|denied|permission|login|authentication)/i.test(
      limitation,
    ) &&
    /(?:screenshot|capture|image|visual|page|source)/i.test(limitation)
  );
}

function failed(
  defects: V3FinishDefect[],
  facts: V3FinishFacts,
): Extract<V3FinishCheckResult, { status: 'failed' }> {
  const fallback: V3FinishDefect = {
    code: 'finish_check_failed',
    message: 'Deterministic finish checks failed without a specific defect.',
  };
  const first = defects[0] ?? fallback;
  return {
    status: 'failed',
    defects: [first, ...defects.slice(1)],
    facts,
  };
}
