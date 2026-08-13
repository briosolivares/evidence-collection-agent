import type { OutputSpec } from '../contracts/outputContract.js';
import { EVIDENCE_ID_PREFIX } from '../evidence/evidenceStore.js';
import { SCRATCH_DIR } from '../run/artifacts.js';

// The evidence-marked document source (T8). Prose is the one deliverable
// shape the model must still author itself, so the leverage is not in owning
// the words — it is in owning the LINK between a sentence and the record that
// backs it, and in checking that link before anything is published.
//
// The model writes one artifact, the marked source: ordinary prose with
// inline `[evidence:E17]` markers. This module reads it. Two properties are
// worth the machinery:
//
//  1. A cited id always exists. An id the run never issued is a fabricated
//     citation — exactly the failure the evidence ledger exists to prevent —
//     and it fails the write, not the verifier's patience.
//  2. Coverage is the contract's decision, not the model's mood. The three
//     policies (`none`, `at_least_one`, `per_required_section`) are checked
//     mechanically, and `per_required_section` names every section that came
//     up short in ONE result, so a single rejected call is enough to fix the
//     whole document.
//
// Nothing here writes, renders, or publishes. Validation returns an
// AcceptedDocumentSource, and renderDocument.ts can render only that — so
// "published bytes were checked against the marked source" holds by
// construction rather than by discipline.

/** Run-dir subdirectory holding each document's marked source. Private
 * working state (the reviewable input, not the deliverable), so it lives
 * under scratch/ and its writes carry no roles. */
export const DOCUMENTS_DIR = `${SCRATCH_DIR}/documents`;

/**
 * Where one document's marked source is stored.
 *
 * @param outputId - contract output id (already validated by the contract's
 *   own id schema: letters, digits, `.`, `_`, `-`, so it is always a safe
 *   single path segment)
 * @returns the run-dir-relative path, always `.md` — the source is Markdown
 *   even when the published deliverable is plain text or a PDF, because the
 *   marker syntax and any headings are Markdown-shaped
 */
export function documentSourcePath(outputId: string): string {
  return `${DOCUMENTS_DIR}/${outputId}/source.md`;
}

/**
 * The marker grammar, in one model-facing sentence. Reused verbatim in tool
 * descriptions and error messages so the model is never told two different
 * stories about the syntax.
 *
 * ```
 * marker  ::= "[" keyword ":" id-list "]"
 * keyword ::= "evidence"        (matched case-insensitively)
 * id-list ::= id ("," id)*      (spaces allowed around ids and commas)
 * id      ::= "E" digit+        (E1, E17 — exactly the ids the ledger issues)
 * ```
 *
 * A marker never spans a line break: the closing `]` must be on the same
 * line, so an unterminated `[evidence:` is left as literal prose rather than
 * silently swallowing the rest of the document.
 */
export const EVIDENCE_MARKER_SYNTAX =
  `Cite evidence inline as [evidence:${EVIDENCE_ID_PREFIX}1] — several ids in one ` +
  `marker are comma-separated, e.g. [evidence:${EVIDENCE_ID_PREFIX}1, ${EVIDENCE_ID_PREFIX}7]. ` +
  `A marker must open and close on the same line.`;

/** A document output as the contract declares it. Its `evidenceRequirement`
 * and `evidencePresentation` are always present in this (post-parse) form:
 * the schema applies its defaults, so no consumer re-derives a policy. */
export type DocumentOutputSpec = Extract<OutputSpec, { kind: 'document' }>;

/** The citable facts about one evidence record — the subset a document needs
 * to check a citation and to print a footnote. Structurally satisfied by
 * `Evidence` from the ledger, so `store.get` is a valid lookup with no
 * adapter. */
export interface CitedEvidence {
  /** Stable evidence id (`E1`, `E2`, ...). */
  id: string;
  /** One-line description of what was captured. */
  summary: string;
  /** URL the evidence came from, when one applies. */
  sourceUrl?: string;
}

/**
 * Resolve an evidence id to its citable facts, or `undefined` when the run
 * never issued that id. Injected rather than imported: validation and
 * footnote rendering then work identically over the live ledger, a replayed
 * run, and a test double.
 */
export type DocumentEvidenceLookup = (evidenceId: string) => CitedEvidence | undefined;

/** One `[evidence:...]` marker found in a source, with the location needed
 * to remove or replace it and to point the model at it. */
export interface EvidenceMarker {
  /** The exact matched text, e.g. `"[evidence:E1, E7]"`. */
  raw: string;
  /** Character offset of the marker's `[` within the source. */
  start: number;
  /** Character offset one past the marker's `]`. */
  end: number;
  /** 1-based line the marker sits on (markers never span lines). */
  line: number;
  /** Well-formed ids cited here, in written order, deduplicated within this
   * marker. */
  evidenceIds: string[];
  /** Tokens inside the marker that are not ids at all (`foo`, `e1`, `E`).
   * Kept rather than dropped: a typo'd citation must fail loudly, because
   * silently ignoring it would publish an unsupported claim. */
  malformedIds: string[];
}

/** One located required section: where its heading is, and how far its body
 * runs. */
export interface DocumentSection {
  /** The required section name from the contract, verbatim. */
  title: string;
  /** The heading line that satisfies it, verbatim. */
  heading: string;
  /** 1-based line number of that heading. */
  headingLine: number;
  /** Character offset where the section starts — the heading line's first
   * character. The heading is included on purpose: a marker written on the
   * heading line cites that section. */
  start: number;
  /** Character offset one past the section's last character (the start of
   * the next heading at the same or shallower level, or the end of the
   * source). */
  end: number;
}

/**
 * A document source that has passed every check its contract imposes — the
 * only input the renderers accept.
 *
 * Holding the source, its markers, and its located sections together is what
 * makes the Markdown/text and PDF renderings provably the same document:
 * both are pure functions of this value.
 */
export interface AcceptedDocumentSource {
  /** The contract output this source satisfies. */
  outputId: string;
  /** The marked source, byte-for-byte as supplied — these are the bytes
   * saved under scratch/documents/, so the reviewable input and the checked
   * input can never diverge. */
  source: string;
  /** Every marker found, in document order. */
  markers: readonly EvidenceMarker[];
  /** Cited ids in first-appearance order, deduplicated across the document.
   * This order is what footnote numbering is derived from. */
  citedEvidenceIds: readonly string[];
  /** The contract's required sections as located in the source, in contract
   * order. Empty when the contract declares none. */
  sections: readonly DocumentSection[];
}

/** Either the source the renderers may consume, or every reason it was
 * rejected. Errors are plural: one rejected call should be enough for the
 * model to fix the whole document. */
export type DocumentEvidenceValidation =
  | { ok: true; document: AcceptedDocumentSource }
  | { ok: false; errors: [string, ...string[]] };

/** Recognizes a marker and captures its raw id list. Deliberately permissive
 * inside the brackets: anything up to the first `]` on the line is captured
 * and then validated, so `[evidence:foo]` becomes a reported error instead of
 * unrecognized prose that reaches the published file. */
const MARKER_PATTERN = /\[evidence\s*:([^\]\r\n]*)\]/gi;

/** A well-formed evidence id, built from the ledger's own prefix so the two
 * cannot drift apart. */
const EVIDENCE_ID_PATTERN = new RegExp(`^${EVIDENCE_ID_PREFIX}[0-9]+$`);

/** An ATX Markdown heading: up to three leading spaces, 1–6 `#`, a space,
 * then the title (with optional closing `#`s stripped). */
const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Find every `[evidence:...]` marker in a document source.
 *
 * @param source - the marked source exactly as the model wrote it
 * @returns the markers in document order, each with its character range, its
 *   1-based line, its well-formed ids, and any tokens that are not ids.
 *   Purely lexical: nothing here knows whether an id exists, so this is safe
 *   to call on rejected input (the tool uses it to decide whether a
 *   ledger-less run may proceed at all)
 *
 * Grammar: see {@link EVIDENCE_MARKER_SYNTAX}. The keyword is matched
 * case-insensitively, ids are not (`e1` is reported as malformed rather than
 * corrected to `E1` — guessing at a citation is exactly what must not
 * happen). Duplicate ids inside one marker collapse to one.
 */
export function parseEvidenceMarkers(source: string): EvidenceMarker[] {
  const lineStarts = lineStartOffsets(source);
  const markers: EvidenceMarker[] = [];

  for (const match of source.matchAll(MARKER_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    const evidenceIds: string[] = [];
    const malformedIds: string[] = [];

    for (const token of (match[1] ?? '').split(',')) {
      const trimmed = token.trim();
      // An empty token is an empty citation, not a malformed id: it is
      // reported once, by the marker, as "cites no ids".
      if (trimmed === '') continue;
      if (EVIDENCE_ID_PATTERN.test(trimmed)) {
        if (!evidenceIds.includes(trimmed)) evidenceIds.push(trimmed);
      } else if (!malformedIds.includes(trimmed)) {
        malformedIds.push(trimmed);
      }
    }

    markers.push({
      raw,
      start,
      end: start + raw.length,
      line: lineNumberOf(lineStarts, start),
      evidenceIds,
      malformedIds,
    });
  }
  return markers;
}

/**
 * Locate a contract's required sections inside a document source.
 *
 * @param source - the marked source
 * @param requiredSections - section names from the contract, in contract
 *   order
 * @returns one entry per section that was found, in contract order; sections
 *   with no matching heading are simply absent (the caller reports them,
 *   because whether that is fatal depends on the caller)
 *
 * A line is a heading when it is an ATX Markdown heading (`## Findings`) or
 * when the line on its own equals a required section name — the second form
 * is how a plain-text document marks its sections, and treating it as a
 * heading is what lets `text` and `markdown` documents share one checker.
 * Matching normalizes case, surrounding whitespace, a trailing colon, and
 * internal whitespace runs; a heading that merely CONTAINS the section name
 * (`## 2. Findings and gaps`) matches only when no heading matches exactly.
 * A section's body runs to the next heading at the same or shallower level,
 * so subsections count toward the section they sit under.
 */
export function findRequiredSections(
  source: string,
  requiredSections: readonly string[],
): DocumentSection[] {
  const lines = splitSourceLines(source);
  const wanted = new Map(requiredSections.map((title) => [normalizeHeading(title), title]));

  // One pass to classify heading lines. A plain-text heading is treated as
  // level 1: it is the coarsest possible section marker, so an ATX heading
  // that follows it ends it, which is the reading a human would give too.
  const headings: Array<{ level: number; text: string; lineIndex: number }> = [];
  for (const [lineIndex, line] of lines.entries()) {
    const atx = ATX_HEADING_PATTERN.exec(line.text);
    if (atx !== null) {
      headings.push({ level: atx[1]!.length, text: atx[2] ?? '', lineIndex });
      continue;
    }
    if (wanted.has(normalizeHeading(line.text)) && line.text.trim() !== '') {
      headings.push({ level: 1, text: line.text, lineIndex });
    }
  }

  const found: DocumentSection[] = [];
  for (const title of requiredSections) {
    const normalized = normalizeHeading(title);
    const exact = headings.findIndex((heading) => normalizeHeading(heading.text) === normalized);
    // Containment is the fallback, never the first choice: an exact "Findings"
    // must win over an earlier "Findings and gaps" that merely contains it.
    const index =
      exact >= 0
        ? exact
        : headings.findIndex((heading) => normalizeHeading(heading.text).includes(normalized));
    if (index < 0) continue;

    const heading = headings[index]!;
    const next = headings.slice(index + 1).find((later) => later.level <= heading.level);
    found.push({
      title,
      heading: lines[heading.lineIndex]!.text,
      headingLine: heading.lineIndex + 1,
      start: lines[heading.lineIndex]!.start,
      end: next === undefined ? source.length : lines[next.lineIndex]!.start,
    });
  }
  return found;
}

/**
 * Check one document source against its contract: every cited id exists, and
 * the contract's coverage policy is satisfied.
 *
 * @param spec - the contract's document output (its `evidenceRequirement`
 *   and `evidencePresentation` are already resolved by the schema)
 * @param content - the marked source exactly as the model supplied it; never
 *   trusted, never normalized
 * @param lookup - resolves an evidence id to its citable facts; a run with
 *   no ledger passes a lookup that returns `undefined` for everything, and
 *   every citation then fails as unknown
 * @returns `ok: true` with the AcceptedDocumentSource the renderers accept,
 *   or `ok: false` with one message per problem. Every message names the
 *   output id and the offending id, marker, line, or section
 *
 * Rejects: blank content; a malformed marker; a marker citing nothing; an id
 * the run never issued; no citation at all under `at_least_one` or
 * `per_required_section`; a required section with no citation under
 * `per_required_section`; and a declared required section the document does
 * not contain — under EVERY policy, because the contract requires the
 * section either way and finding out at publish time is strictly better than
 * finding out from the verifier. `none` still rejects unknown and malformed
 * ids: "no evidence is required" is not "any citation is fine".
 */
export function validateDocumentEvidence(
  spec: DocumentOutputSpec,
  content: string,
  lookup: DocumentEvidenceLookup,
): DocumentEvidenceValidation {
  const label = `document ${JSON.stringify(spec.id)}`;
  if (typeof content !== 'string' || content.trim() === '') {
    return {
      ok: false,
      errors: [`${label} has no content: supply the document's full text as content.`],
    };
  }

  const markers = parseEvidenceMarkers(content);
  const errors: string[] = [...checkMarkerSyntax(label, markers), ...checkCitedIds(label, markers, lookup)];

  const requiredSections = spec.requiredSections ?? [];
  const sections = findRequiredSections(content, requiredSections);
  for (const title of requiredSections) {
    if (!sections.some((section) => section.title === title)) {
      errors.push(
        `${label} is missing required section ${JSON.stringify(title)}. Add it as a ` +
          `heading spelled exactly as the contract declares it.`,
      );
    }
  }

  errors.push(...checkCoverage(label, spec, markers, sections));

  if (errors.length > 0) {
    const [first, ...rest] = errors;
    return { ok: false, errors: [first!, ...rest] };
  }

  return {
    ok: true,
    document: {
      outputId: spec.id,
      source: content,
      markers,
      citedEvidenceIds: citedIdsInOrder(markers),
      sections,
    },
  };
}

/** Cited ids in first-appearance order, deduplicated across the document —
 * the numbering order footnotes inherit. */
function citedIdsInOrder(markers: readonly EvidenceMarker[]): string[] {
  const ordered: string[] = [];
  for (const marker of markers) {
    for (const id of marker.evidenceIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }
  return ordered;
}

/** Markers that are syntactically broken: a token that is not an id, or a
 * marker that cites nothing at all. Both would otherwise reach the published
 * file — hidden mode would delete the claim's only support, footnote mode
 * would print a reference to nothing. */
function checkMarkerSyntax(label: string, markers: readonly EvidenceMarker[]): string[] {
  const errors: string[] = [];
  for (const marker of markers) {
    for (const malformed of marker.malformedIds) {
      errors.push(
        `${label} marker ${JSON.stringify(marker.raw)} on line ${marker.line} contains ` +
          `${JSON.stringify(malformed)}, which is not an evidence id. ${EVIDENCE_MARKER_SYNTAX}`,
      );
    }
    if (marker.evidenceIds.length === 0 && marker.malformedIds.length === 0) {
      errors.push(
        `${label} marker ${JSON.stringify(marker.raw)} on line ${marker.line} cites no ids. ` +
          `${EVIDENCE_MARKER_SYNTAX} Remove the marker or name the record it rests on.`,
      );
    }
  }
  return errors;
}

/** Every cited id must exist in the run's ledger. Reported once per id, with
 * the first line it appears on: repeating the same unknown id for every
 * sentence that cites it would bury the other problems. */
function checkCitedIds(
  label: string,
  markers: readonly EvidenceMarker[],
  lookup: DocumentEvidenceLookup,
): string[] {
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const marker of markers) {
    for (const id of marker.evidenceIds) {
      if (reported.has(id)) continue;
      reported.add(id);
      if (lookup(id) === undefined) {
        errors.push(
          `${label} cites unknown evidence id ${JSON.stringify(id)} on line ${marker.line}. ` +
            `Cite only ids this run issued: record the extraction first, then cite the id ` +
            `it returns.`,
        );
      }
    }
  }
  return errors;
}

/** The contract's coverage policy. `none` adds nothing here — its ids were
 * still checked above. */
function checkCoverage(
  label: string,
  spec: DocumentOutputSpec,
  markers: readonly EvidenceMarker[],
  sections: readonly DocumentSection[],
): string[] {
  const cited = markers.filter((marker) => marker.evidenceIds.length > 0);

  switch (spec.evidenceRequirement) {
    case 'none':
      return [];

    case 'at_least_one':
      if (cited.length > 0) return [];
      return [
        `${label} cites no evidence, and its contract requires at least one citation. ` +
          EVIDENCE_MARKER_SYNTAX,
      ];

    case 'per_required_section': {
      const errors: string[] = [];
      for (const section of sections) {
        const covered = cited.some(
          (marker) => marker.start >= section.start && marker.start < section.end,
        );
        if (!covered) {
          errors.push(
            `${label} section ${JSON.stringify(section.title)} (heading on line ` +
              `${section.headingLine}) contains no evidence citation, and its contract ` +
              `requires one per required section. ${EVIDENCE_MARKER_SYNTAX}`,
          );
        }
      }
      // A document with no citations anywhere is reported once, plainly,
      // instead of once per section: the fix is the same for all of them.
      if (cited.length === 0 && errors.length > 1) {
        return [
          `${label} cites no evidence, and its contract requires a citation in each of ` +
            `its ${sections.length} required sections ` +
            `(${sections.map((section) => JSON.stringify(section.title)).join(', ')}). ` +
            EVIDENCE_MARKER_SYNTAX,
        ];
      }
      return errors;
    }
  }
}

/** One line of a source, with the offsets needed to map markers onto it. */
interface SourceLine {
  /** The line's text, without its terminator (CR included in neither form). */
  text: string;
  /** Character offset of the line's first character. */
  start: number;
  /** Character offset one past the line's last character. */
  end: number;
}

/**
 * Split a source into lines, accepting LF and CRLF. Exported for the
 * renderers, which rebuild the document line by line: a marker can never
 * span a line break, so every removal or replacement is a local edit.
 */
export function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const breaks = /\r?\n/g;
  let cursor = 0;
  for (const match of source.matchAll(breaks)) {
    lines.push({ text: source.slice(cursor, match.index), start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  lines.push({ text: source.slice(cursor), start: cursor, end: source.length });
  return lines;
}

/** Offsets of each line's first character, computed once so marker line
 * numbers cost one binary search each rather than a rescan. */
function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r?\n/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** The 1-based line an offset falls on. */
function lineNumberOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Compare headings the way a reader would: the `#` prefix, case,
 * surrounding whitespace, a trailing colon or period, and internal
 * whitespace runs are all noise. Deliberately does NOT strip evidence
 * markers — a heading carrying one still matches through the containment
 * rule, and the renderers remove the marker from the published bytes. */
function normalizeHeading(text: string): string {
  return text
    .replace(ATX_HEADING_PATTERN, '$2')
    .trim()
    .replace(/[:.]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
