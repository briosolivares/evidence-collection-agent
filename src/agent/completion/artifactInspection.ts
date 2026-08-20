import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { browserProviderKindSchema } from '../../browser/sessionProvider.js';
import {
  ARTIFACTS_DIR,
  MANIFEST_FILENAME,
  SCRATCH_DIR,
  type ArtifactRole,
  type Manifest,
  type ManifestEntry,
} from '../../run/artifacts.js';
import { resolveRunPath } from '../../run/runDir.js';
import { SCRATCH_WORKSPACE_MAX_FILE_BYTES } from '../../run/syncScratchWorkspace.js';
import type { FinishDefect } from './finishFacts.schema.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STREAM_CHUNK_BYTES = 64 * 1024;

/** Hard bounds for the untrusted run state inspected at finish/resume. */
export const FINISH_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const FINISH_MAX_MANIFEST_ENTRIES = 4_096;
export const FINISH_MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const FINISH_MAX_RETAINED_PUBLISHED_BYTES = 64 * 1024 * 1024;
export const FINISH_SIGNATURE_BYTES = 8;

const canonicalUtcIsoTimestampSchema = z.string().refine(isCanonicalUtcIsoTimestamp, {
  message: 'must be a canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)',
});
const manifestEntryShapeSchema = z
  .object({
    filename: z.string(),
    sha256: z.string(),
    capturedAt: canonicalUtcIsoTimestampSchema,
    sourceUrl: z.string().optional(),
    roles: z.array(z.enum(['requested_output', 'evidence'])).optional(),
    completionStatus: z.enum(['complete', 'partial']).optional(),
  })
  .passthrough();
const manifestShapeSchema = z
  .object({
    task: z.string(),
    startedAt: canonicalUtcIsoTimestampSchema,
    finishedAt: canonicalUtcIsoTimestampSchema.optional(),
    browserProvider: browserProviderKindSchema.optional(),
    artifacts: z.array(manifestEntryShapeSchema),
  })
  .passthrough();

export interface InspectedEntry {
  entry: ManifestEntry;
  canonicalPath: string;
  /** Exact observed length after the streaming integrity read. */
  byteLength?: number;
  /** Full bytes only when the caller declared this published file necessary. */
  bytes?: Uint8Array;
  /** Small caller-requested prefix for signature checks; never populated for scratch. */
  contentPrefix?: Uint8Array;
  integrityVerified: boolean;
}

export interface ManifestInspection {
  manifest?: Manifest;
  entries: InspectedEntry[];
  defects: FinishDefect[];
}

export interface ManifestInspectionLimits {
  maxManifestBytes: number;
  maxManifestEntries: number;
  maxTotalArtifactBytes: number;
  maxRetainedPublishedBytes: number;
}

export interface ManifestInspectionOptions {
  /** Retain full bytes only for published files whose content finish checks parse. */
  retainPublishedBytes?: (entry: ManifestEntry, canonicalPath: string) => boolean;
  /** Retain this many leading bytes for each published file (for signatures). */
  publishedPrefixBytes?: number;
  /** Narrow test seam; production callers should use the exported hard defaults. */
  limits?: Partial<ManifestInspectionLimits>;
  /** Trusted coordinator guard checked between bounded filesystem operations.
   * A thrown cancellation/deadline error propagates unchanged. */
  checkActive?: () => void;
}

const DEFAULT_INSPECTION_LIMITS: ManifestInspectionLimits = {
  maxManifestBytes: FINISH_MAX_MANIFEST_BYTES,
  maxManifestEntries: FINISH_MAX_MANIFEST_ENTRIES,
  maxTotalArtifactBytes: FINISH_MAX_TOTAL_ARTIFACT_BYTES,
  maxRetainedPublishedBytes: FINISH_MAX_RETAINED_PUBLISHED_BYTES,
};

interface PreparedEntry {
  entry: ManifestEntry;
  canonicalPath: string;
  pathInspectable: boolean;
  published: boolean;
  valid: boolean;
  preflightBytes?: number;
  retainBytes: boolean;
}

interface StreamBudget {
  used: number;
  max: number;
  exceeded: boolean;
}

/**
 * Parse and verify the manifest without trusting its TypeScript cast.
 *
 * Every recorded path must be canonical, remain under the run, traverse no
 * symlink, name a regular file, obey the artifacts/scratch role partition,
 * and hash to the recorded digest. Defects are collected rather than thrown
 * so one finish response can repair every objective problem.
 */
export function inspectManifest(
  runDir: string,
  options: ManifestInspectionOptions = {},
): ManifestInspection {
  options.checkActive?.();
  const limits = resolveInspectionLimits(options.limits);
  const prefixBytes = options.publishedPrefixBytes ?? 0;
  if (!Number.isInteger(prefixBytes) || prefixBytes < 0 || prefixBytes > 64 * 1024) {
    throw new Error(
      `publishedPrefixBytes must be an integer between 0 and 65536, got ${prefixBytes}`,
    );
  }
  const manifestPath = join(runDir, MANIFEST_FILENAME);
  const manifestRead = readManifestNoFollow(
    manifestPath,
    limits.maxManifestBytes,
    options.checkActive,
  );
  if ('defect' in manifestRead) {
    return {
      entries: [],
      defects: [manifestRead.defect],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(manifestRead.raw);
  } catch (error) {
    return {
      entries: [],
      defects: [
        {
          code: 'unparseable_manifest',
          message: `${MANIFEST_FILENAME} is not valid JSON: ${errorMessage(error)}.`,
        },
      ],
    };
  }

  const parsed = manifestShapeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      entries: [],
      defects: parsed.error.issues.map((issue) => {
        const artifactEntry = issue.path[0] === 'artifacts' && typeof issue.path[1] === 'number';
        return {
          code: artifactEntry ? 'invalid_manifest_entry' : 'invalid_manifest_shape',
          message:
            `${MANIFEST_FILENAME} ${issue.path.length === 0 ? '' : `${issue.path.join('.')} `}` +
            `${issue.message}. Restore or re-publish the malformed provenance record.`,
        };
      }),
    };
  }

  const manifest: Manifest = parsed.data;
  if (manifest.artifacts.length > limits.maxManifestEntries) {
    return {
      entries: [],
      defects: [
        {
          code: 'manifest_entry_limit_exceeded',
          message:
            `${MANIFEST_FILENAME} contains ${manifest.artifacts.length} entries, above the ` +
            `${limits.maxManifestEntries}-entry inspection limit. Reduce the run to bounded, relevant files.`,
        },
      ],
    };
  }

  const defects: FinishDefect[] = [];
  const prepared: PreparedEntry[] = [];
  const seen = new Set<string>();
  const invalidTimestampEntries = validateTimestampOrder(manifest, defects);

  for (const [entryIndex, entry] of manifest.artifacts.entries()) {
    options.checkActive?.();
    const pathResult = canonicalManifestPath(runDir, entry.filename);
    if ('defect' in pathResult) {
      defects.push({ ...pathResult.defect, artifactPath: entry.filename });
      prepared.push({
        entry,
        canonicalPath: entry.filename,
        pathInspectable: false,
        published: false,
        valid: false,
        retainBytes: false,
      });
      continue;
    }

    const canonicalPath = pathResult.path;
    let valid = !invalidTimestampEntries.has(entryIndex);
    if (seen.has(canonicalPath)) {
      defects.push({
        code: 'duplicate_manifest_entry',
        artifactPath: canonicalPath,
        message: `${canonicalPath} appears more than once in the manifest. Re-publish it so provenance has one authoritative entry.`,
      });
      valid = false;
    }
    seen.add(canonicalPath);

    const published = canonicalPath.startsWith(`${ARTIFACTS_DIR}/`);
    const scratch = canonicalPath.startsWith(`${SCRATCH_DIR}/`);
    if (!published && !scratch) {
      defects.push({
        code: 'manifest_partition_violation',
        artifactPath: canonicalPath,
        message: `${canonicalPath} is outside the artifacts/ and scratch/ workspace partitions.`,
      });
      valid = false;
    }

    const roles = entry.roles;
    if (published) {
      if (!Array.isArray(roles) || roles.length === 0) {
        defects.push({
          code: 'published_artifact_missing_roles',
          artifactPath: canonicalPath,
          message: `${canonicalPath} is published but has no semantic role. Re-publish it with requested_output, evidence, or both.`,
        });
        valid = false;
      } else {
        const unique = new Set(roles);
        if (unique.size !== roles.length) {
          defects.push({
            code: 'invalid_artifact_roles',
            artifactPath: canonicalPath,
            message: `${canonicalPath} has invalid or duplicate manifest roles. Re-publish it with a unique subset of requested_output and evidence.`,
          });
          valid = false;
        }
      }
    } else if (scratch && roles !== undefined) {
      defects.push({
        code: 'scratch_artifact_has_roles',
        artifactPath: canonicalPath,
        message: `${canonicalPath} is private scratch state but carries published roles. Reconcile the workspace manifest.`,
      });
      valid = false;
    }

    if (!SHA256_PATTERN.test(entry.sha256)) {
      defects.push({
        code: 'invalid_manifest_hash',
        artifactPath: canonicalPath,
        message: `${canonicalPath} has an invalid SHA-256 value in the manifest. Re-publish it through the artifact boundary.`,
      });
      valid = false;
    }
    if (entry.sourceUrl !== undefined) {
      try {
        new URL(entry.sourceUrl);
      } catch {
        defects.push({
          code: 'invalid_source_url',
          artifactPath: canonicalPath,
          message: `${canonicalPath} has an invalid source URL in the manifest. Re-publish it with auditable provenance.`,
        });
        valid = false;
      }
    }

    prepared.push({
      entry,
      canonicalPath,
      pathInspectable: true,
      published,
      valid,
      retainBytes: false,
    });
  }

  let totalArtifactBytes = 0;
  for (const item of prepared) {
    options.checkActive?.();
    if (!item.pathInspectable) continue;
    const metadata = inspectRegularFileMetadataNoFollow(
      runDir,
      item.canonicalPath,
    );
    if ('defect' in metadata) {
      defects.push(metadata.defect);
      item.valid = false;
      continue;
    }
    item.preflightBytes = metadata.byteLength;
    if (metadata.byteLength > SCRATCH_WORKSPACE_MAX_FILE_BYTES) {
      defects.push(artifactTooLargeDefect(item.canonicalPath, metadata.byteLength));
      item.valid = false;
    }
    totalArtifactBytes = safeAdd(totalArtifactBytes, metadata.byteLength);
  }

  if (totalArtifactBytes > limits.maxTotalArtifactBytes) {
    defects.push({
      code: 'artifact_inspection_bytes_exceeded',
      message:
        `The manifest records ${totalArtifactBytes} artifact bytes, above the ` +
        `${limits.maxTotalArtifactBytes}-byte aggregate inspection limit. ` +
        'Remove irrelevant scratch or published files before finishing.',
    });
    return { entries: [], defects };
  }

  let retainedPublishedBytes = 0;
  for (const item of prepared) {
    options.checkActive?.();
    if (
      !item.published ||
      item.preflightBytes === undefined ||
      options.retainPublishedBytes?.(item.entry, item.canonicalPath) !== true
    ) {
      continue;
    }
    item.retainBytes = true;
    retainedPublishedBytes = safeAdd(retainedPublishedBytes, item.preflightBytes);
  }
  const retainContent = retainedPublishedBytes <= limits.maxRetainedPublishedBytes;
  if (!retainContent) {
    defects.push({
      code: 'published_inspection_bytes_exceeded',
      message:
        `Deterministic finish checks require ${retainedPublishedBytes} published content bytes, ` +
        `above the ${limits.maxRetainedPublishedBytes}-byte in-memory inspection limit. ` +
        'Split or reduce the requested outputs before finishing.',
    });
  }

  const streamBudget: StreamBudget = {
    used: 0,
    max: limits.maxTotalArtifactBytes,
    exceeded: false,
  };
  const retentionBudget: StreamBudget = {
    used: 0,
    max: limits.maxRetainedPublishedBytes,
    exceeded: false,
  };
  const entries: InspectedEntry[] = [];
  for (const item of prepared) {
    options.checkActive?.();
    if (item.preflightBytes === undefined || streamBudget.exceeded) {
      entries.push({
        entry: item.entry,
        canonicalPath: item.canonicalPath,
        ...(item.preflightBytes === undefined ? {} : { byteLength: item.preflightBytes }),
        integrityVerified: false,
      });
      continue;
    }

    const read = hashRegularFileNoFollow(
      runDir,
      item.canonicalPath,
      item.published ? prefixBytes : 0,
      retainContent && item.retainBytes,
      streamBudget,
      retentionBudget,
      options.checkActive,
    );
    if ('defect' in read) {
      defects.push(read.defect);
      item.valid = false;
      entries.push({
        entry: item.entry,
        canonicalPath: item.canonicalPath,
        ...(read.byteLength === undefined ? {} : { byteLength: read.byteLength }),
        integrityVerified: false,
      });
      continue;
    }
    if (read.retentionExceeded && !defects.some((defect) => defect.code === 'published_inspection_bytes_exceeded')) {
      defects.push({
        code: 'published_inspection_bytes_exceeded',
        artifactPath: item.canonicalPath,
        message:
          `Published content grew beyond the ${limits.maxRetainedPublishedBytes}-byte ` +
          'in-memory inspection limit while it was being read. Re-publish a bounded output.',
      });
    }
    if (read.hash !== item.entry.sha256) {
      defects.push({
        code: 'hash_mismatch',
        artifactPath: item.canonicalPath,
        message:
          `${item.canonicalPath} changed after publication (manifest ${item.entry.sha256.slice(0, 12)}…, ` +
          `actual ${read.hash.slice(0, 12)}…). Re-publish the current bytes.`,
      });
      item.valid = false;
    }

    entries.push({
      entry: item.entry,
      canonicalPath: item.canonicalPath,
      byteLength: read.byteLength,
      ...(read.bytes === undefined ? {} : { bytes: read.bytes }),
      ...(read.contentPrefix === undefined ? {} : { contentPrefix: read.contentPrefix }),
      integrityVerified:
        item.valid && read.hash === item.entry.sha256,
    });
  }

  return { manifest, entries, defects };
}

function canonicalManifestPath(
  runDir: string,
  filename: string,
): { path: string } | { defect: FinishDefect } {
  let absolute: string;
  try {
    absolute = resolveRunPath(runDir, filename);
  } catch {
    return {
      defect: {
        code: 'manifest_path_escape',
        message: `Manifest entry ${JSON.stringify(filename)} does not resolve inside the run directory.`,
      },
    };
  }
  const normalized = toPortablePath(relative(resolve(runDir), absolute));
  if (normalized !== toPortablePath(filename)) {
    return {
      defect: {
        code: 'noncanonical_manifest_path',
        message: `Manifest entry ${JSON.stringify(filename)} is not canonical; re-publish it as ${JSON.stringify(normalized)}.`,
      },
    };
  }
  return { path: normalized };
}

function inspectRegularFileMetadataNoFollow(
  runDir: string,
  artifactPath: string,
): { byteLength: number } | { defect: FinishDefect } {
  const opened = openRegularFileNoFollow(runDir, artifactPath);
  if ('defect' in opened) return opened;
  try {
    return { byteLength: opened.byteLength };
  } finally {
    closeSync(opened.descriptor);
  }
}

function openRegularFileNoFollow(
  runDir: string,
  artifactPath: string,
):
  | { descriptor: number; byteLength: number }
  | { defect: FinishDefect } {
  let absolute: string;
  try {
    absolute = resolveRunPath(runDir, artifactPath);
  } catch {
    return {
      defect: {
        code: 'manifest_path_escape',
        artifactPath,
        message: `Manifest entry ${JSON.stringify(artifactPath)} does not resolve inside the run directory.`,
      },
    };
  }
  const root = resolve(runDir);
  const parent = dirname(absolute);
  const parentRelative = relative(root, parent);
  let cursor = root;
  for (const segment of parentRelative.split(sep).filter((part) => part !== '')) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        return {
          defect: {
            code: 'artifact_symlink',
            artifactPath,
            message: `${artifactPath} traverses a symlink. Re-publish regular files entirely inside the run directory.`,
          },
        };
      }
    } catch (error) {
      return {
        defect: {
          code: 'missing_recorded_file',
          artifactPath,
          message: `${artifactPath} is recorded in the manifest but its parent path is missing or unreadable: ${errorMessage(error)}.`,
        },
      };
    }
  }

  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(absolute, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      defect: {
        code: code === 'ELOOP' ? 'artifact_symlink' : 'missing_recorded_file',
        artifactPath,
        message:
          code === 'ELOOP'
            ? `${artifactPath} is a symlink, not a published regular file.`
            : `${artifactPath} is recorded in the manifest but is missing or unreadable: ${errorMessage(error)}.`,
      },
    };
  }

  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      closeSync(descriptor);
      return {
        defect: {
          code: 'artifact_not_regular_file',
          artifactPath,
          message: `${artifactPath} is not a regular file. Re-publish it as ordinary file bytes.`,
        },
      };
    }
    return { descriptor, byteLength: stat.size };
  } catch (error) {
    closeSync(descriptor);
    return {
      defect: {
        code: 'unreadable_recorded_file',
        artifactPath,
        message: `${artifactPath} could not be read: ${errorMessage(error)}.`,
      },
    };
  }
}

function hashRegularFileNoFollow(
  runDir: string,
  artifactPath: string,
  prefixBytes: number,
  retainBytes: boolean,
  totalBudget: StreamBudget,
  retainedBudget: StreamBudget,
  checkActive: (() => void) | undefined,
):
  | {
      hash: string;
      byteLength: number;
      bytes?: Uint8Array;
      contentPrefix?: Uint8Array;
      retentionExceeded: boolean;
    }
  | { defect: FinishDefect; byteLength?: number } {
  const opened = openRegularFileNoFollow(runDir, artifactPath);
  if ('defect' in opened) return opened;
  if (opened.byteLength > SCRATCH_WORKSPACE_MAX_FILE_BYTES) {
    closeSync(opened.descriptor);
    return {
      defect: artifactTooLargeDefect(artifactPath, opened.byteLength),
      byteLength: opened.byteLength,
    };
  }

  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const retainedChunks: Buffer[] = [];
  const prefixChunks: Buffer[] = [];
  let retainedForEntry = 0;
  let prefixed = 0;
  let byteLength = 0;
  let retentionExceeded = false;
  let activeCheckFailed = false;
  try {
    while (true) {
      try {
        checkActive?.();
      } catch (error) {
        activeCheckFailed = true;
        throw error;
      }
      const count = readSync(opened.descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      if (byteLength + count > SCRATCH_WORKSPACE_MAX_FILE_BYTES) {
        return {
          defect: artifactTooLargeDefect(artifactPath, byteLength + count, true),
          byteLength: byteLength + count,
        };
      }
      if (totalBudget.used + count > totalBudget.max) {
        totalBudget.exceeded = true;
        return {
          defect: {
            code: 'artifact_inspection_bytes_exceeded',
            artifactPath,
            message:
              `Artifact bytes grew beyond the ${totalBudget.max}-byte aggregate ` +
              'inspection limit while files were being hashed. Remove irrelevant files and retry.',
          },
          byteLength: byteLength + count,
        };
      }
      totalBudget.used += count;
      byteLength += count;
      const view = chunk.subarray(0, count);
      hash.update(view);

      if (prefixed < prefixBytes) {
        const take = Math.min(count, prefixBytes - prefixed);
        prefixChunks.push(Buffer.from(view.subarray(0, take)));
        prefixed += take;
      }
      if (retainBytes && !retentionExceeded) {
        if (retainedBudget.used + count > retainedBudget.max) {
          retainedBudget.used -= retainedForEntry;
          retainedChunks.length = 0;
          retainedForEntry = 0;
          retainedBudget.exceeded = true;
          retentionExceeded = true;
        } else {
          retainedChunks.push(Buffer.from(view));
          retainedBudget.used += count;
          retainedForEntry += count;
        }
      }
    }
    return {
      hash: hash.digest('hex'),
      byteLength,
      ...(retainBytes && !retentionExceeded
        ? { bytes: Buffer.concat(retainedChunks, retainedForEntry) }
        : {}),
      ...(prefixBytes > 0
        ? { contentPrefix: Buffer.concat(prefixChunks, prefixed) }
        : {}),
      retentionExceeded,
    };
  } catch (error) {
    if (activeCheckFailed) throw error;
    return {
      defect: {
        code: 'unreadable_recorded_file',
        artifactPath,
        message: `${artifactPath} could not be read: ${errorMessage(error)}.`,
      },
      byteLength,
    };
  } finally {
    closeSync(opened.descriptor);
  }
}

function readManifestNoFollow(
  manifestPath: string,
  maxBytes: number,
  checkActive?: () => void,
): { raw: string } | { defect: FinishDefect } {
  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(manifestPath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      defect: {
        code: code === 'ELOOP' ? 'unsafe_manifest_file' : 'missing_manifest',
        message:
          code === 'ELOOP'
            ? `${MANIFEST_FILENAME} is a symlink; run provenance must be an ordinary file.`
            : `${MANIFEST_FILENAME} is missing or unreadable. Preserve the run directory and retry only after its provenance is restored.`,
      },
    };
  }

  let activeCheckFailed = false;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return {
        defect: {
          code: 'unsafe_manifest_file',
          message: `${MANIFEST_FILENAME} is not a regular file. Restore ordinary bounded provenance JSON.`,
        },
      };
    }
    if (stat.size > maxBytes) return { defect: manifestTooLargeDefect(stat.size, maxBytes) };

    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, maxBytes + 1));
    while (true) {
      try {
        checkActive?.();
      } catch (error) {
        activeCheckFailed = true;
        throw error;
      }
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) return { defect: manifestTooLargeDefect(total, maxBytes) };
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const bytes = Buffer.concat(chunks, total);
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return {
        defect: {
          code: 'unparseable_manifest',
          message: `${MANIFEST_FILENAME} is not valid UTF-8 JSON.`,
        },
      };
    }
    return { raw };
  } catch (error) {
    if (activeCheckFailed) throw error;
    return {
      defect: {
        code: 'missing_manifest',
        message: `${MANIFEST_FILENAME} is missing or unreadable. Preserve the run directory and retry only after its provenance is restored.`,
      },
    };
  } finally {
    closeSync(descriptor);
  }
}

function validateTimestampOrder(
  manifest: Manifest,
  defects: FinishDefect[],
): Set<number> {
  const invalidEntries = new Set<number>();
  const startedAt = Date.parse(manifest.startedAt);
  const finishedAt = manifest.finishedAt === undefined
    ? undefined
    : Date.parse(manifest.finishedAt);
  if (finishedAt !== undefined && finishedAt < startedAt) {
    defects.push({
      code: 'invalid_manifest_timestamp_order',
      message: `${MANIFEST_FILENAME} finishedAt precedes startedAt. Restore chronologically ordered provenance.`,
    });
  }
  for (const [index, entry] of manifest.artifacts.entries()) {
    const capturedAt = Date.parse(entry.capturedAt);
    if (capturedAt < startedAt) {
      invalidEntries.add(index);
      defects.push({
        code: 'invalid_manifest_timestamp_order',
        artifactPath: entry.filename,
        message: `${entry.filename} capturedAt precedes the run startedAt timestamp. Re-publish it with truthful provenance.`,
      });
    }
    if (finishedAt !== undefined && capturedAt > finishedAt) {
      invalidEntries.add(index);
      defects.push({
        code: 'invalid_manifest_timestamp_order',
        artifactPath: entry.filename,
        message: `${entry.filename} capturedAt follows the run finishedAt timestamp. Restore chronologically ordered provenance.`,
      });
    }
  }
  return invalidEntries;
}

function resolveInspectionLimits(
  overrides: Partial<ManifestInspectionLimits> | undefined,
): ManifestInspectionLimits {
  const limits = { ...DEFAULT_INSPECTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer, got ${value}`);
    }
  }
  return limits;
}

function artifactTooLargeDefect(
  artifactPath: string,
  byteLength: number,
  grew = false,
): FinishDefect {
  return {
    code: 'artifact_too_large',
    artifactPath,
    message: grew
      ? `${artifactPath} grew beyond the ${SCRATCH_WORKSPACE_MAX_FILE_BYTES}-byte artifact inspection limit while being read.`
      : `${artifactPath} is ${byteLength} bytes, above the artifact inspection limit of ${SCRATCH_WORKSPACE_MAX_FILE_BYTES}. Publish a bounded artifact.`,
  };
}

function manifestTooLargeDefect(
  observedBytes: number,
  maxBytes: number,
): FinishDefect {
  return {
    code: 'manifest_bytes_limit_exceeded',
    message:
      `${MANIFEST_FILENAME} is at least ${observedBytes} bytes, above the ` +
      `${maxBytes}-byte inspection limit. Restore bounded provenance JSON.`,
  };
}

function safeAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!CANONICAL_UTC_ISO_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function artifactBasename(entry: InspectedEntry): string {
  return basename(entry.canonicalPath);
}

export function hasRole(entry: InspectedEntry, role: ArtifactRole): boolean {
  return Array.isArray(entry.entry.roles) && entry.entry.roles.includes(role);
}

export function isPng(bytes: Uint8Array | undefined): boolean {
  return (
    bytes !== undefined &&
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/** Conservative media candidates inferred from trusted bytes and filename. */
export function inferMediaTypes(bytes: Uint8Array, filename: string): string[] {
  if (startsWithAscii(bytes, '%PDF-')) return ['application/pdf'];
  if (isPng(bytes)) return ['image/png'];
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ['image/jpeg'];
  if (startsWithAscii(bytes, 'GIF8')) return ['image/gif'];
  if (startsWithAscii(bytes, 'BM')) return ['image/bmp'];
  if (startsWithAscii(bytes, 'RIFF') && includesAscii(bytes, 'WEBP', 16)) {
    return ['image/webp'];
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (includesAscii(bytes, 'xl/', Math.min(bytes.length, 64 * 1024))) {
      return ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    }
    return ['application/zip'];
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    return ['application/vnd.ms-excel'];
  }

  const text = decodeUtf8(bytes);
  if (text !== undefined) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(text);
        return ['application/json'];
      } catch {
        // Invalid JSON-shaped text remains text/plain.
      }
    }
    if (/^<(?:!doctype html|html|\?xml|!--)/i.test(trimmed)) return ['text/html'];
    const lower = filename.toLowerCase();
    if (lower.endsWith('.csv')) return ['text/csv', 'text/plain'];
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      return ['text/markdown', 'text/plain'];
    }
    return ['text/plain'];
  }
  return ['application/octet-stream'];
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return startsWith(
    bytes,
    [...value].map((character) => character.charCodeAt(0)),
  );
}

function includesAscii(bytes: Uint8Array, value: string, limit: number): boolean {
  return Buffer.from(bytes.subarray(0, limit)).toString('latin1').includes(value);
}

function toPortablePath(value: string): string {
  return value.split(sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
