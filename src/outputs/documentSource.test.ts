import { describe, expect, it } from 'vitest';

import {
  documentSourcePath,
  findRequiredSections,
  parseEvidenceMarkers,
  validateDocumentEvidence,
  type CitedEvidence,
  type DocumentEvidenceLookup,
  type DocumentOutputSpec,
} from './documentSource.js';

function spec(overrides: Partial<DocumentOutputSpec> = {}): DocumentOutputSpec {
  return {
    id: 'brief',
    kind: 'document',
    filename: 'brief.md',
    format: 'markdown',
    evidenceRequirement: 'at_least_one',
    evidencePresentation: 'hidden',
    ...overrides,
  } as DocumentOutputSpec;
}

/** A ledger holding E1..E3, so an unknown id is anything else. */
const ledger: Record<string, CitedEvidence> = {
  E1: { id: 'E1', summary: 'Member count from the directory header', sourceUrl: 'https://x.test/a' },
  E2: { id: 'E2', summary: 'Roster rows extracted from the table' },
  E3: { id: 'E3', summary: 'Filing date from the cover page', sourceUrl: 'https://x.test/c' },
};
const lookup: DocumentEvidenceLookup = (id) => ledger[id];

describe('parseEvidenceMarkers', () => {
  it('finds one marker with its exact range and line', () => {
    const source = 'First line.\nThe gap is real [evidence:E1].\n';
    const [marker, ...rest] = parseEvidenceMarkers(source);

    expect(rest).toEqual([]);
    expect(marker).toMatchObject({ raw: '[evidence:E1]', line: 2, evidenceIds: ['E1'], malformedIds: [] });
    expect(source.slice(marker!.start, marker!.end)).toBe('[evidence:E1]');
  });

  it('reads several ids from one marker, allowing spaces, and dedupes within it', () => {
    const [marker] = parseEvidenceMarkers('Backed twice [evidence: E1 , E2, E1 ].');
    expect(marker?.evidenceIds).toEqual(['E1', 'E2']);
  });

  it('matches the keyword case-insensitively but never guesses at an id', () => {
    const [upper] = parseEvidenceMarkers('a [EVIDENCE:E7] b');
    expect(upper?.evidenceIds).toEqual(['E7']);

    // A lower-case id is reported, not silently corrected: guessing at a
    // citation is the failure this whole path exists to prevent.
    const [lower] = parseEvidenceMarkers('a [evidence:e7] b');
    expect(lower?.evidenceIds).toEqual([]);
    expect(lower?.malformedIds).toEqual(['e7']);
  });

  it('reports non-id tokens instead of dropping them', () => {
    const [marker] = parseEvidenceMarkers('a [evidence:E1, page 4, X9] b');
    expect(marker?.evidenceIds).toEqual(['E1']);
    expect(marker?.malformedIds).toEqual(['page 4', 'X9']);
  });

  it('treats an empty marker as citing nothing rather than as a malformed id', () => {
    const [marker] = parseEvidenceMarkers('a [evidence: ] b');
    expect(marker?.evidenceIds).toEqual([]);
    expect(marker?.malformedIds).toEqual([]);
  });

  it('does not let an unterminated marker swallow the rest of the document', () => {
    expect(parseEvidenceMarkers('a [evidence:E1\nnext line [evidence:E2]')).toMatchObject([
      { evidenceIds: ['E2'], line: 2 },
    ]);
  });

  it('numbers lines through CRLF as well as LF', () => {
    const markers = parseEvidenceMarkers('one\r\ntwo [evidence:E1]\r\n\r\nfour [evidence:E2]');
    expect(markers.map((marker) => marker.line)).toEqual([2, 4]);
  });

  it('finds nothing in unmarked prose', () => {
    expect(parseEvidenceMarkers('Plain prose with [brackets] and a : colon.')).toEqual([]);
  });
});

describe('findRequiredSections', () => {
  const source = [
    'Preamble text.',
    '',
    '## Findings',
    '',
    'Body of findings.',
    '',
    '### Detail',
    '',
    'A subsection of findings.',
    '',
    '## Gaps',
    '',
    'Body of gaps.',
    '',
  ].join('\n');

  it('locates Markdown headings and runs each section to the next same-level heading', () => {
    const [findings, gaps] = findRequiredSections(source, ['Findings', 'Gaps']);

    expect(findings).toMatchObject({ title: 'Findings', heading: '## Findings', headingLine: 3 });
    expect(gaps).toMatchObject({ title: 'Gaps', headingLine: 11 });
    // A subsection belongs to the section it sits under.
    expect(source.slice(findings!.start, findings!.end)).toContain('A subsection of findings.');
    expect(source.slice(findings!.start, findings!.end)).not.toContain('Body of gaps.');
    expect(source.slice(gaps!.start, gaps!.end)).toContain('Body of gaps.');
  });

  it('treats a bare line as a heading, so plain-text documents have sections too', () => {
    const plain = 'Findings\nBody of findings.\n\nGaps\nBody of gaps.\n';
    const [findings, gaps] = findRequiredSections(plain, ['Findings', 'Gaps']);

    expect(findings).toMatchObject({ heading: 'Findings', headingLine: 1 });
    expect(plain.slice(findings!.start, findings!.end)).not.toContain('Body of gaps.');
    expect(gaps).toMatchObject({ headingLine: 4 });
  });

  it('matches a decorated heading only when nothing matches exactly', () => {
    const decorated = '## 2. Findings and gaps\n\nBody.\n';
    expect(findRequiredSections(decorated, ['Findings'])[0]).toMatchObject({
      heading: '## 2. Findings and gaps',
    });

    // An exact heading later in the document still wins over an earlier
    // containing one.
    const both = '## Findings and gaps\n\nOne.\n\n## Findings\n\nTwo.\n';
    expect(findRequiredSections(both, ['Findings'])[0]).toMatchObject({ heading: '## Findings' });
  });

  it('ignores case, trailing punctuation, and repeated whitespace', () => {
    expect(findRequiredSections('### material   GAPS:\n\nBody.\n', ['Material gaps'])).toHaveLength(1);
  });

  it('omits a section the document does not contain', () => {
    expect(findRequiredSections(source, ['Findings', 'Recommendations'])).toMatchObject([
      { title: 'Findings' },
    ]);
  });
});

describe('validateDocumentEvidence', () => {
  it('accepts a cited document and reports its cited ids in first-appearance order', () => {
    const result = validateDocumentEvidence(
      spec(),
      'Second [evidence:E2]. First again [evidence:E2] and [evidence:E1].',
      lookup,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.citedEvidenceIds).toEqual(['E2', 'E1']);
    // The accepted source is the supplied bytes, untouched: it is what the
    // reviewable scratch copy will hold.
    expect(result.document.source).toContain('[evidence:E2]');
    expect(result.document.markers).toHaveLength(3);
  });

  it('rejects blank content', () => {
    const result = validateDocumentEvidence(spec(), '   \n\t\n', lookup);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors[0]).toContain('has no content');
  });

  it('rejects an id the run never issued, naming the id and its line once', () => {
    const result = validateDocumentEvidence(
      spec(),
      'One [evidence:E9].\nTwo [evidence:E9].\nThree [evidence:E1].',
      lookup,
    );

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"E9"');
    expect(result.errors[0]).toContain('line 1');
  });

  it('rejects a malformed marker and an empty marker, each with its line', () => {
    const result = validateDocumentEvidence(
      spec(),
      'Cited [evidence:E1].\nTypo [evidence:e1].\nEmpty [evidence:].',
      lookup,
    );

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('"e1"');
    expect(result.errors.join('\n')).toContain('line 2');
    expect(result.errors.join('\n')).toContain('cites no ids');
    expect(result.errors.join('\n')).toContain('line 3');
  });

  it('rejects an uncited document under the default at_least_one policy', () => {
    const result = validateDocumentEvidence(spec(), 'Confident prose, no sources.', lookup);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors[0]).toContain('cites no evidence');
    expect(result.errors[0]).toContain('[evidence:E1]');
  });

  describe('evidenceRequirement: none', () => {
    const uncited = spec({ evidenceRequirement: 'none' });

    it('accepts a document with no markers at all', () => {
      const result = validateDocumentEvidence(uncited, 'A summary of the method used.', lookup);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.citedEvidenceIds).toEqual([]);
    });

    it('still rejects an unknown id — "no evidence required" is not "any citation goes"', () => {
      const result = validateDocumentEvidence(uncited, 'Claim [evidence:E42].', lookup);
      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.errors[0]).toContain('"E42"');
    });
  });

  describe('evidenceRequirement: per_required_section', () => {
    const perSection = spec({
      evidenceRequirement: 'per_required_section',
      requiredSections: ['Findings', 'Gaps', 'Recommendations'],
    });

    const covered = [
      'Preamble [evidence:E1].',
      '',
      '## Findings',
      '',
      'Backed [evidence:E1].',
      '',
      '### Detail',
      '',
      'More [evidence:E2].',
      '',
      '## Gaps',
      '',
      'Backed [evidence:E2].',
      '',
      '## Recommendations',
      '',
      'Backed [evidence:E3].',
      '',
    ].join('\n');

    it('accepts a document whose every required section cites something', () => {
      const result = validateDocumentEvidence(perSection, covered, lookup);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.sections.map((section) => section.title)).toEqual([
        'Findings',
        'Gaps',
        'Recommendations',
      ]);
    });

    it('counts a citation in a subsection toward the section it sits under', () => {
      const viaSubsection = covered.replace('Backed [evidence:E1].', 'Unbacked prose.');
      expect(validateDocumentEvidence(perSection, viaSubsection, lookup).ok).toBe(true);
    });

    it('names every uncovered section, and only those', () => {
      const thin = covered
        .replace('Backed [evidence:E2].', 'Nothing here.')
        .replace('Backed [evidence:E3].', 'Nothing here either.');
      const result = validateDocumentEvidence(perSection, thin, lookup);

      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('"Gaps"');
      expect(result.errors[1]).toContain('"Recommendations"');
      expect(result.errors.join('\n')).not.toContain('"Findings"');
    });

    it('does not let a preamble citation cover the first section', () => {
      const preambleOnly = [
        'Preamble [evidence:E1].',
        '',
        '## Findings',
        '',
        'Unbacked.',
        '',
        '## Gaps',
        '',
        'Backed [evidence:E2].',
        '',
        '## Recommendations',
        '',
        'Backed [evidence:E3].',
      ].join('\n');
      const result = validateDocumentEvidence(perSection, preambleOnly, lookup);

      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('"Findings"');
    });

    it('collapses "cites nothing anywhere" into one message naming every section', () => {
      const bare = covered.replace(/ ?\[evidence:E\d+\]/g, '');
      const result = validateDocumentEvidence(perSection, bare, lookup);

      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('cites no evidence');
      for (const section of ['Findings', 'Gaps', 'Recommendations']) {
        expect(result.errors[0]).toContain(`"${section}"`);
      }
    });

    it('reports a required section the document never wrote', () => {
      const missing = covered.replace('## Recommendations', '## Next steps');
      const result = validateDocumentEvidence(perSection, missing, lookup);

      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.errors.join('\n')).toContain('missing required section "Recommendations"');
    });
  });

  it('reports a missing required section even when the policy needs no evidence', () => {
    // The contract asked for the section either way; learning about it at
    // publish time beats learning about it from the verifier.
    const result = validateDocumentEvidence(
      spec({ evidenceRequirement: 'none', requiredSections: ['Method'] }),
      'A document with no Method heading.',
      lookup,
    );

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors[0]).toContain('missing required section "Method"');
  });

  it('treats a lookup that resolves nothing as a run with no usable ledger', () => {
    const result = validateDocumentEvidence(spec(), 'Claim [evidence:E1].', () => undefined);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors[0]).toContain('"E1"');
  });
});

describe('documentSourcePath', () => {
  it('keeps each document\'s marked source in its own private scratch folder', () => {
    expect(documentSourcePath('summary_brief')).toBe('scratch/documents/summary_brief/source.md');
  });
});
