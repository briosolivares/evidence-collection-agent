/**
 * The run's evidence ledger (T6): every fact the agent extracts gets a
 * short, stable id the model can cite and an on-disk record an auditor can
 * re-read byte for byte.
 *
 * Two design rules make evidence trustworthy rather than decorative:
 *
 * 1. Ids are opaque and stable (`E1`, `E2`, ...). They are short enough for
 *    the model to carry in prose and table cells (T7/T8 link rows and
 *    footnotes to them), and they are never reused — a failed persist does
 *    not burn a number, and nothing re-numbers an existing record.
 * 2. The full record always lands on disk before the id is handed out.
 *    Model-facing results are size-capped; the persisted record is not, so
 *    "the model saw a preview" and "the run kept the whole extraction" stay
 *    independent facts.
 *
 * Evidence is private working state, not a deliverable: records live under
 * `scratch/evidence/` and therefore carry NO artifact roles (see
 * `assertWorkspacePartition` in src/run/artifacts.ts — the presence of the
 * roles field is itself the published/private marker). They are still
 * hashed into the manifest, because tamper evidence is total. Publishing an
 * extraction as a graded output stays a separate, deliberate write through
 * write_file / screenshot with explicit roles.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { readManifest, SCRATCH_DIR, writeArtifact, type ManifestEntry } from '../run/artifacts.js';
import { resolveRunPath } from '../run/runDir.js';

/** Run-dir subdirectory holding one JSON file per evidence record. Private
 * working state: under scratch/, so these writes take no roles. */
export const EVIDENCE_DIR = `${SCRATCH_DIR}/evidence`;

/** Prefix of every evidence id. Deliberately one character: the model
 * repeats these ids inside table cells and footnotes, where every byte is
 * paid for in context. */
export const EVIDENCE_ID_PREFIX = 'E';

/**
 * What a piece of evidence is. T6 starts with page-JavaScript extractions;
 * later tasks add their own kinds (T7 table completeness, T8 document
 * sources) rather than overloading this one.
 */
export type EvidenceKind = 'javascript_extraction';

/** Every kind the store accepts, for runtime validation of the union. */
const EVIDENCE_KINDS: readonly EvidenceKind[] = ['javascript_extraction'];

/** What a caller supplies to record one piece of evidence. */
export interface EvidenceInput {
  /** What kind of evidence this is; drives how consumers read `detail`. */
  kind: EvidenceKind;
  /** One-line, model-facing description of what was captured — this is what
   * the model sees when it cites the id without re-reading the record. */
  summary: string;
  /** URL the evidence was captured from, when one applies. Recorded as the
   * manifest entry's `sourceUrl` as well, so provenance survives outside
   * the record file. */
  sourceUrl?: string;
  /** The complete kind-specific record, persisted uncapped. Must be
   * JSON-serializable: `undefined`, a function, a symbol, a bigint, or a
   * cycle is a caller bug and throws. Nested values JSON drops silently
   * (e.g. a function inside an object) are the *caller's* problem to
   * validate — page values go through `assertJsonCompatible` first for
   * exactly that reason. */
  detail: unknown;
}

/** The persisted form of one piece of evidence: exactly the bytes stored at
 * `scratch/evidence/<id>.json`. Deliberately excludes the record's own path
 * and hash, which would be self-referential. */
export interface EvidenceRecord {
  /** Stable evidence id ('E1', 'E2', ...). */
  id: string;
  /** What kind of evidence this is. */
  kind: EvidenceKind;
  /** One-line description of what was captured. */
  summary: string;
  /** URL the evidence was captured from, when one applies. */
  sourceUrl?: string;
  /** ISO 8601 timestamp of when the evidence was recorded. */
  recordedAt: string;
  /** The complete kind-specific record. */
  detail: unknown;
}

/** One recorded piece of evidence, plus where its bytes live and what they
 * hash to — the same values the manifest holds for the record file. */
export interface Evidence extends EvidenceRecord {
  /** Run-dir-relative path of the persisted record, usable directly with
   * read_file / grep. */
  path: string;
  /** Lowercase hex SHA-256 of the persisted record's exact bytes. */
  sha256: string;
}

/**
 * The run's evidence ledger. In-memory index over records that are already
 * durable: every entry `get`/`list` returns has been written to disk and
 * hashed into the manifest.
 */
export interface EvidenceStore {
  /** Absolute path of the run directory records are persisted into. */
  readonly runDir: string;
  /**
   * Persist one piece of evidence and index it. The implementation seam —
   * call {@link recordEvidence} instead at ordinary call sites (a test
   * double replaces this one method).
   */
  record(input: EvidenceInput): Evidence;
  /** Look up evidence by id, or undefined when the id was never issued. */
  get(id: string): Evidence | undefined;
  /** Every recorded piece of evidence, in the order it was recorded. */
  list(): readonly Evidence[];
}

/**
 * Create an empty evidence ledger for one run.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; recording throws otherwise (writing nothing), because an
 *   unrecorded file is not evidence
 * @returns a store that issues ids from `E1` upward and persists each
 *   record under `scratch/evidence/`
 * @throws TypeError when `runDir` is empty
 */
export function createEvidenceStore(runDir: string): EvidenceStore {
  if (runDir === '') {
    throw new TypeError('evidence store requires a run directory');
  }
  return buildEvidenceStore(runDir, 0, []);
}

/**
 * Rebuild a run's evidence ledger from what is already durable on disk —
 * for a run resumed from a checkpoint, where a fresh `createEvidenceStore`
 * would otherwise start empty and orphan every id minted before the
 * interruption.
 *
 * Enumeration goes through the manifest, never a directory scan: the
 * manifest is the run's single source of truth about which files are real
 * and what they hash to, so a stray file nothing ever recorded (e.g. left
 * behind by a crashed write) cannot resurrect as evidence.
 *
 * @param runDir - absolute path to a run directory whose manifest has been
 *   initialized; throws if the manifest is missing
 * @returns a store seeded with every manifest-recorded record under
 *   `scratch/evidence/`, indexed in ascending numeric id order so `list()`
 *   reproduces the original recording order, with the next id issued one
 *   past the highest numeric id found (or `E1` when none were recorded) —
 *   matching exactly what a continuous, uninterrupted run would issue next
 * @throws Error naming the offending file when a record's on-disk bytes no
 *   longer match the hash the manifest recorded, its JSON does not parse, or
 *   its `id` disagrees with the filename it was read from. Resuming past a
 *   silently missing or silently wrong record is exactly the failure this
 *   function exists to close, so a bad record aborts the whole restore
 *   rather than being skipped.
 */
export function restoreEvidenceStore(runDir: string): EvidenceStore {
  if (runDir === '') {
    throw new TypeError('evidence store requires a run directory');
  }

  const manifest = readManifest(runDir);
  const evidenceEntries = manifest.artifacts.filter(
    (entry) => entry.filename === EVIDENCE_DIR || entry.filename.startsWith(`${EVIDENCE_DIR}/`),
  );

  const restored = evidenceEntries
    .map((entry) => restoreOne(runDir, entry))
    // Ascending numeric order, not manifest order: the manifest lists an
    // entry's *most recent* write, which is recording order for evidence
    // (never rewritten in place) but shouldn't be relied on incidentally.
    .sort((a, b) => idSequenceNumber(a.id) - idSequenceNumber(b.id));

  // Seed from the highest id found, never the record count: a gap (e.g.
  // E1, E3 with E2 missing for any reason) must not let the counter reissue
  // an id that is already on disk under a different record.
  const highest = restored.reduce(
    (max, evidence) => Math.max(max, idSequenceNumber(evidence.id)),
    0,
  );

  return buildEvidenceStore(
    runDir,
    highest,
    restored.map((evidence) => [evidence.id, evidence] as const),
  );
}

/**
 * The one implementation behind both `createEvidenceStore` (empty start)
 * and `restoreEvidenceStore` (seeded from disk). Keeping `record`/`get`/
 * `list` in a single place is what guarantees the two constructors behave
 * identically from this point on: the next id a restored store issues is
 * exactly the id a continuous, never-interrupted run would have issued.
 */
function buildEvidenceStore(
  runDir: string,
  startSequence: number,
  initialEntries: ReadonlyArray<readonly [string, Evidence]>,
): EvidenceStore {
  // Counter and index are separate from disk so a failed write leaves no
  // trace at all: no id consumed, no half-recorded entry to reason about.
  let sequence = startSequence;
  const byId = new Map<string, Evidence>(initialEntries);

  return {
    runDir,

    record(input: EvidenceInput): Evidence {
      assertRecordable(input);

      const id = `${EVIDENCE_ID_PREFIX}${sequence + 1}`;
      const record: EvidenceRecord = {
        id,
        kind: input.kind,
        summary: input.summary,
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
        recordedAt: new Date().toISOString(),
        detail: input.detail,
      };
      const json = serializeRecord(record);

      // Persist first: the id is only issued once the bytes are durable and
      // hashed, so a cited id can never name a record that does not exist.
      // No roles — scratch/ writes are private by construction.
      const entry = writeArtifact(runDir, `${EVIDENCE_DIR}/${id}.json`, Buffer.from(json, 'utf8'), {
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      });

      // Re-parse rather than reuse the caller's object: the in-memory record
      // is then exactly what disk holds, and later mutation of the caller's
      // `detail` cannot silently diverge from the persisted bytes.
      const evidence: Evidence = {
        ...(JSON.parse(json) as EvidenceRecord),
        path: entry.filename,
        sha256: entry.sha256,
      };
      sequence += 1;
      byId.set(id, evidence);
      return evidence;
    },

    get(id: string): Evidence | undefined {
      return byId.get(id);
    },

    list(): readonly Evidence[] {
      return [...byId.values()];
    },
  };
}

/**
 * Record one piece of evidence: persist the complete record and return the
 * citable handle. The free-function form every caller uses.
 *
 * @param store - the run's evidence ledger
 * @param input - the evidence to record; `detail` must be JSON-serializable
 * @returns the new evidence with its stable id, its run-dir-relative path,
 *   and the SHA-256 of the exact bytes on disk — the file exists and is in
 *   the manifest before this returns
 * @throws TypeError for an unknown kind, a blank summary, or a `detail`
 *   value JSON cannot represent; propagates the write failure (no id
 *   consumed) when the run directory has no manifest
 */
export function recordEvidence(store: EvidenceStore, input: EvidenceInput): Evidence {
  return store.record(input);
}

/** Top-level `detail` types JSON cannot represent. Given as a top-level
 * value each of these would make the record's `detail` key vanish rather
 * than fail — an evidence record with no evidence in it. */
const UNREPRESENTABLE_DETAIL_TYPES: readonly string[] = ['undefined', 'function', 'symbol', 'bigint'];

/** Reject inputs that would produce a record no one can read back: an
 * unknown kind, a summary that says nothing, or a detail JSON cannot
 * represent. Checked before any write, so a rejected record leaves no file
 * and no id behind. */
function assertRecordable(input: EvidenceInput): void {
  if (!EVIDENCE_KINDS.includes(input.kind)) {
    throw new TypeError(
      `unknown evidence kind ${JSON.stringify(input.kind)}; ` +
        `known kinds: ${EVIDENCE_KINDS.join(', ')}`,
    );
  }
  // Typed as string, checked as unknown: the summary is the only part of a
  // record a reader sees without opening the file, so a run that reached here
  // through an `any` (a tool result, a JSON-parsed replay) must not be able to
  // mint an unreadable citation.
  if (typeof input.summary !== 'string' || input.summary.trim() === '') {
    throw new TypeError('evidence summary must be a non-empty description');
  }
  if (UNREPRESENTABLE_DETAIL_TYPES.includes(typeof input.detail)) {
    throw new TypeError(
      `evidence detail must be JSON-serializable, got ${typeof input.detail}`,
    );
  }
}

/** Serialize a record to the exact bytes stored on disk. Pretty-printed and
 * newline-terminated like the manifest: evidence is read by humans
 * (auditors) as well as by grep and read_file. */
function serializeRecord(record: EvidenceRecord): string {
  try {
    // A cycle or a nested bigint throws here; `assertRecordable` has already
    // ruled out the top-level types JSON would drop without complaint.
    return `${JSON.stringify(record, null, 2)}\n`;
  } catch (thrown) {
    throw new TypeError(
      `evidence detail must be JSON-serializable: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
}

/**
 * Read, hash-verify, and parse one manifest-recorded evidence file for
 * {@link restoreEvidenceStore}.
 *
 * The three checks run in this order deliberately: bytes are verified
 * against the manifest's hash *before* they are trusted enough to parse, so
 * a tampered file is reported as a hash mismatch (the more specific,
 * actionable fault) rather than as a downstream JSON or shape error.
 *
 * @throws Error naming `entry.filename` when the on-disk bytes no longer
 *   hash to what the manifest recorded, the bytes are not valid JSON, or the
 *   parsed record's `id` disagrees with the id its filename encodes
 */
function restoreOne(runDir: string, entry: ManifestEntry): Evidence {
  const bytes = readFileSync(resolveRunPath(runDir, entry.filename));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.sha256) {
    throw new Error(
      `evidence file ${entry.filename} does not match its manifest hash ` +
        `(manifest: ${entry.sha256}, on disk: ${sha256}) — the record may have been ` +
        'tampered with since it was recorded',
    );
  }

  let record: EvidenceRecord;
  try {
    record = JSON.parse(bytes.toString('utf8')) as EvidenceRecord;
  } catch (thrown) {
    throw new Error(
      `evidence file ${entry.filename} is not valid JSON: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }

  // The filename, not just the parsed body, is the id's other witness: the
  // two must agree, or a record could be cited under an id that names a
  // different file than the one actually holding those bytes.
  const idFromFilename = basename(entry.filename, '.json');
  if (record.id !== idFromFilename) {
    throw new Error(
      `evidence file ${entry.filename} holds record id ${JSON.stringify(record.id)}, ` +
        `which does not match the id ${JSON.stringify(idFromFilename)} its filename encodes`,
    );
  }

  return {
    ...record,
    path: entry.filename,
    sha256,
  };
}

/** Numeric suffix of a store-issued evidence id (`E12` -> `12`), used to
 * order restored records and to seed the id counter from the highest one
 * found. Throws rather than defaulting to 0 for anything not shaped like an
 * id this store issued — silently ignoring it could under-seed the counter
 * and reissue an id already on disk. */
function idSequenceNumber(id: string): number {
  const match = new RegExp(`^${EVIDENCE_ID_PREFIX}(\\d+)$`).exec(id);
  if (!match) {
    throw new Error(`not a well-formed evidence id (expected ${EVIDENCE_ID_PREFIX}<number>): ${JSON.stringify(id)}`);
  }
  return Number(match[1]);
}
