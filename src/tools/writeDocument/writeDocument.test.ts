import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputSpec } from '../../contracts/outputContract.js';
import { createOutputContractStore } from '../../contracts/outputContractStore.js';
import { createEvidenceStore, recordEvidence } from '../../evidence/evidenceStore.js';
import type {
  CitedEvidence,
  DocumentEvidenceLookup,
  DocumentOutputSpec,
} from '../../outputs/documentSource.js';
import type { PdfRenderPage } from '../../outputs/renderDocument.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { executeToolCall, type ToolCallResult } from '../pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from '../registry.js';
import {
  createWriteDocumentTool,
  WRITE_DOCUMENT_TOOL_NAME,
  type WriteDocumentDeps,
  type WriteDocumentResult,
} from './writeDocument.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'write-document-test-'));
  initManifest(runDir, 'test task');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function documentSpec(overrides: Partial<DocumentOutputSpec> = {}): DocumentOutputSpec {
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

const ledger: Record<string, CitedEvidence> = {
  E1: { id: 'E1', summary: 'Member count from the directory header', sourceUrl: 'https://x.test/a' },
  E2: { id: 'E2', summary: 'Roster rows extracted from the table' },
};
const lookup: DocumentEvidenceLookup = (id) => ledger[id];

/** A PDF page seam that returns fixed bytes and keeps the HTML it was given. */
function fakePdfPage() {
  let html = '';
  let opens = 0;
  const open = async (): Promise<PdfRenderPage> => {
    opens += 1;
    return {
      disableNetwork: async () => {},
      setHtml: async (value: string) => {
        html = value;
      },
      toPdf: async () => Buffer.from('%PDF-1.4 fake bytes', 'utf8'),
      close: async () => {},
    };
  };
  return { open, html: () => html, opens: () => opens };
}

/** Drive the tool the way the model does: through the pipeline, so a throw is
 * observed as the structured error result the model would read. */
function call(
  deps: WriteDocumentDeps,
  input: unknown,
  ctx: Partial<ToolCtx> = {},
): Promise<ToolCallResult> {
  const registry = createRegistry([createWriteDocumentTool(deps) as ToolDef]);
  return executeToolCall(
    registry,
    { id: 'call-1', name: WRITE_DOCUMENT_TOOL_NAME, input },
    { runDir, ...ctx },
  );
}

/** Deps for a run with one markdown document and a working ledger lookup. */
function deps(
  specs: readonly DocumentOutputSpec[] = [documentSpec()],
  overrides: Partial<WriteDocumentDeps> = {},
): WriteDocumentDeps {
  return {
    documentSpecs: () => specs,
    evidence: () => lookup,
    ...overrides,
  };
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

function entryFor(filename: string) {
  return manifest().artifacts.find((entry) => entry.filename === filename);
}

function sha256Of(relPath: string): string {
  return createHash('sha256').update(readFileSync(join(runDir, relPath))).digest('hex');
}

function published(result: unknown): WriteDocumentResult {
  return JSON.parse(String(result)) as WriteDocumentResult;
}

describe('write_document publication', () => {
  const source = [
    '# Chapter roster',
    '',
    '## Findings',
    '',
    'The chapter lists 42 members [evidence:E1].',
    '',
    'The roster rows agree [evidence:E2].',
    '',
  ].join('\n');

  it('keeps the marked source in scratch and publishes the clean rendering, both hashed', async () => {
    const result = await call(deps(), { outputId: 'brief', content: source });
    expect(result.isError).toBe(false);
    const summary = published(result.content);

    // Both files exist, and both hashes in the manifest match the bytes on
    // disk — the provenance the grader reads is not a claim, it is checkable.
    expect(summary.sourcePath).toBe('scratch/documents/brief/source.md');
    expect(summary.publishedPath).toBe('artifacts/brief.md');
    expect(readFileSync(join(runDir, summary.sourcePath), 'utf8')).toBe(source);
    expect(summary.sourceSha256).toBe(sha256Of(summary.sourcePath));
    expect(summary.publishedSha256).toBe(sha256Of(summary.publishedPath));
    expect(entryFor(summary.sourcePath)?.sha256).toBe(summary.sourceSha256);
    expect(entryFor(summary.publishedPath)?.sha256).toBe(summary.publishedSha256);
    expect(summary.citedEvidenceIds).toEqual(['E1', 'E2']);
  });

  it('records the workspace roles the partition requires: none on the source, requested_output on the deliverable', async () => {
    await call(deps(), { outputId: 'brief', content: source });

    // The presence of `roles` is itself the published/private marker (see
    // assertWorkspacePartition), so this is not cosmetic bookkeeping.
    expect(entryFor('scratch/documents/brief/source.md')).not.toHaveProperty('roles');
    expect(entryFor('artifacts/brief.md')?.roles).toEqual(['requested_output']);
  });

  it('publishes no raw evidence id under the default hidden presentation', async () => {
    await call(deps(), { outputId: 'brief', content: source });
    const text = readFileSync(join(runDir, 'artifacts/brief.md'), 'utf8');

    expect(text).toBe(
      [
        '# Chapter roster',
        '',
        '## Findings',
        '',
        'The chapter lists 42 members.',
        '',
        'The roster rows agree.',
        '',
      ].join('\n'),
    );
    expect(text).not.toContain('evidence:');
    expect(text).not.toMatch(/\bE[0-9]+\b/);
    // The marked source still carries them — that is what makes it reviewable.
    expect(readFileSync(join(runDir, 'scratch/documents/brief/source.md'), 'utf8')).toContain(
      '[evidence:E1]',
    );
  });

  it('publishes stable, readable references when the contract asks for footnotes', async () => {
    await call(deps([documentSpec({ evidencePresentation: 'footnotes' })]), {
      outputId: 'brief',
      content: source,
    });
    const text = readFileSync(join(runDir, 'artifacts/brief.md'), 'utf8');

    expect(text).toContain('The chapter lists 42 members [1].');
    expect(text).toContain('The roster rows agree [2].');
    expect(text).toContain('## Sources');
    expect(text).toContain('[1] E1 — Member count from the directory header (https://x.test/a)');
    expect(text).toContain('[2] E2 — Roster rows extracted from the table');
  });

  it('reads the filename, format, and policy from the live contract, revision by revision', async () => {
    const contracts = createOutputContractStore(runDir);
    const withDocument = (filename: string, presentation: 'hidden' | 'footnotes'): OutputSpec => ({
      id: 'brief',
      kind: 'document',
      filename,
      format: 'markdown',
      evidenceRequirement: 'at_least_one',
      evidencePresentation: presentation,
    });
    expect(
      contracts.setOutputContract({ contract: { outputs: [withDocument('v1.md', 'hidden')] } }).ok,
    ).toBe(true);

    // Exactly the wiring the INTEGRATION note prescribes.
    const contractDeps = deps([], {
      documentSpecs: (ctx) =>
        (ctx.outputContracts?.currentContract()?.outputs ?? []).filter(
          (output): output is DocumentOutputSpec => output.kind === 'document',
        ),
    });

    await call(contractDeps, { outputId: 'brief', content: source }, { outputContracts: contracts });
    expect(existsSync(join(runDir, 'artifacts/v1.md'))).toBe(true);

    expect(
      contracts.setOutputContract({
        contract: { outputs: [withDocument('v2.md', 'footnotes')] },
        revisionBasis: { kind: 'assumption_correction', summary: 'the brief must show citations' },
      }).ok,
    ).toBe(true);
    await call(contractDeps, { outputId: 'brief', content: source }, { outputContracts: contracts });

    // The revision decides both the name and the presentation; the model's
    // input never mentioned either.
    expect(readFileSync(join(runDir, 'artifacts/v2.md'), 'utf8')).toContain('## Sources');
  });

  it('accepts a lookup backed by the run\'s real evidence ledger', async () => {
    const store = createEvidenceStore(runDir);
    const evidence = recordEvidence(store, {
      kind: 'javascript_extraction',
      summary: '42 members listed in the chapter header',
      sourceUrl: 'https://chapter.test/roster',
      detail: { count: 42 },
    });

    await call(
      deps([documentSpec({ evidencePresentation: 'footnotes' })], {
        // EvidenceStore.get satisfies DocumentEvidenceLookup structurally.
        evidence: () => (id) => store.get(id),
      }),
      { outputId: 'brief', content: `Roster size confirmed [evidence:${evidence.id}].` },
    );

    expect(readFileSync(join(runDir, 'artifacts/brief.md'), 'utf8')).toContain(
      `[1] ${evidence.id} — 42 members listed in the chapter header (https://chapter.test/roster)`,
    );
  });
});

describe('write_document rejection', () => {
  /** Every path a rejected call must leave untouched. */
  function assertNothingWritten(): void {
    expect(manifest().artifacts).toEqual([]);
    expect(existsSync(join(runDir, 'artifacts/brief.md'))).toBe(false);
    expect(existsSync(join(runDir, 'scratch/documents'))).toBe(false);
    expect(readdirSync(join(runDir, 'artifacts'))).toEqual([]);
  }

  it('rejects an unknown evidence id before publishing anything', async () => {
    const result = await call(deps(), {
      outputId: 'brief',
      content: 'The chapter lists 42 members [evidence:E9].',
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('"E9"');
    expect(result.content).toContain('wrote NOTHING');
    assertNothingWritten();
  });

  it('rejects an uncited document when the contract requires evidence', async () => {
    const result = await call(deps(), {
      outputId: 'brief',
      content: 'Confident prose with no sources at all.',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('cites no evidence');
    assertNothingWritten();
  });

  it('names every under-covered section for a per-section contract', async () => {
    const perSection = documentSpec({
      evidenceRequirement: 'per_required_section',
      requiredSections: ['Findings', 'Gaps', 'Recommendations'],
    });
    const result = await call(deps([perSection]), {
      outputId: 'brief',
      content: [
        '## Findings',
        '',
        'Backed [evidence:E1].',
        '',
        '## Gaps',
        '',
        'Unbacked.',
        '',
        '## Recommendations',
        '',
        'Also unbacked.',
        '',
      ].join('\n'),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"Gaps"');
    expect(result.content).toContain('"Recommendations"');
    expect(result.content).not.toContain('"Findings"');
    assertNothingWritten();
  });

  it('rejects a document missing a required section', async () => {
    const result = await call(
      deps([documentSpec({ requiredSections: ['Findings', 'Gaps'] })]),
      { outputId: 'brief', content: '## Findings\n\nBacked [evidence:E1].\n' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('missing required section "Gaps"');
    assertNothingWritten();
  });

  it('rejects an outputId the contract does not declare, listing the ones it does', async () => {
    const result = await call(deps([documentSpec({ id: 'summary_brief' })]), {
      outputId: 'brief',
      content: 'Backed [evidence:E1].',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"summary_brief"');
    assertNothingWritten();
  });

  it('says so plainly when the contract requires no documents at all', async () => {
    const result = await call(deps([]), { outputId: 'brief', content: 'Backed [evidence:E1].' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('requires no document outputs');
    assertNothingWritten();
  });

  it('rejects a pdf output when the run has no page to render in', async () => {
    const result = await call(deps([documentSpec({ format: 'pdf', filename: 'brief.pdf' })]), {
      outputId: 'brief',
      content: 'Backed [evidence:E1].',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no browser page to render one in');
    expect(existsSync(join(runDir, 'artifacts/brief.pdf'))).toBe(false);
    assertNothingWritten();
  });

  it('rejects citations in a run with no evidence ledger', async () => {
    const result = await call(deps([documentSpec()], { evidence: () => undefined }), {
      outputId: 'brief',
      content: 'Backed [evidence:E1].',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no evidence ledger');
    assertNothingWritten();
  });

  it('publishes an evidence-free document in a ledger-less run', async () => {
    const result = await call(
      deps([documentSpec({ evidenceRequirement: 'none' })], { evidence: () => undefined }),
      { outputId: 'brief', content: 'A note on the method, making no factual claim.' },
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(runDir, 'artifacts/brief.md'), 'utf8')).toBe(
      'A note on the method, making no factual claim.\n',
    );
  });

  it('refuses a filename that escapes the run directory, writing nothing', async () => {
    // The contract's own validation rejects these, so reaching here means a
    // mis-wired documentSpecs dep — which must still not write outside the run.
    const escape = join(runDir, '..', 'write-document-escape.md');
    rmSync(escape, { force: true });

    const result = await call(deps([documentSpec({ filename: '../write-document-escape.md' })]), {
      outputId: 'brief',
      content: 'Backed [evidence:E1].',
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(existsSync(escape)).toBe(false);
    assertNothingWritten();
  });

  it('rejects a document that is nothing but citations', async () => {
    const result = await call(deps(), { outputId: 'brief', content: '[evidence:E1] [evidence:E2]' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no text left');
    assertNothingWritten();
  });

  it('rejects input carrying anything but outputId and content', async () => {
    // Filename, format, and presentation are contract decisions: the schema
    // must refuse to even discuss them.
    for (const extra of [{ filename: 'mine.md' }, { format: 'pdf' }, { roles: ['evidence'] }]) {
      const result = await call(deps(), {
        outputId: 'brief',
        content: 'Backed [evidence:E1].',
        ...extra,
      });
      expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    }
    assertNothingWritten();
  });
});

describe('write_document PDF output', () => {
  const source = '## Findings\n\nThe chapter lists 42 members [evidence:E1].\n';

  it('publishes the rendered PDF bytes and keeps the same marked source', async () => {
    const page = fakePdfPage();
    const result = await call(
      deps([documentSpec({ format: 'pdf', filename: 'brief.pdf' })], {
        openPdfPage: page.open,
      }),
      { outputId: 'brief', content: source },
    );

    expect(result.isError).toBe(false);
    const summary = published(result.content);
    expect(summary).toMatchObject({ format: 'pdf', publishedPath: 'artifacts/brief.pdf' });
    expect(readFileSync(join(runDir, 'artifacts/brief.pdf'), 'utf8')).toBe('%PDF-1.4 fake bytes');
    expect(summary.publishedSha256).toBe(sha256Of('artifacts/brief.pdf'));
    expect(readFileSync(join(runDir, summary.sourcePath), 'utf8')).toBe(source);
    expect(page.opens()).toBe(1);
  });

  it('renders the PDF from the same accepted source as the markdown deliverable', async () => {
    const page = fakePdfPage();
    const specs = [
      documentSpec({ id: 'brief', filename: 'brief.md', format: 'markdown' }),
      documentSpec({ id: 'brief_pdf', filename: 'brief.pdf', format: 'pdf' }),
    ];
    const both = deps(specs, { openPdfPage: page.open });

    await call(both, { outputId: 'brief', content: source });
    await call(both, { outputId: 'brief_pdf', content: source });

    const markdown = readFileSync(join(runDir, 'artifacts/brief.md'), 'utf8');
    const html = page.html();
    // Same text, same marker-free rendering, one accepted source behind both.
    for (const line of markdown.split('\n').filter((line) => line.trim() !== '')) {
      expect(html).toContain(line.replace(/^#+\s*/, ''));
    }
    expect(html).not.toContain('evidence:');
    expect(readFileSync(join(runDir, 'scratch/documents/brief/source.md'), 'utf8')).toBe(
      readFileSync(join(runDir, 'scratch/documents/brief_pdf/source.md'), 'utf8'),
    );
  });

  it('writes nothing when the PDF render fails', async () => {
    const result = await call(
      deps([documentSpec({ format: 'pdf', filename: 'brief.pdf' })], {
        openPdfPage: async () => ({
          disableNetwork: async () => {},
          setHtml: async () => {
            throw new Error('page crashed');
          },
          toPdf: async () => Buffer.from(''),
          close: async () => {},
        }),
      }),
      { outputId: 'brief', content: source },
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('page crashed');
    expect(manifest().artifacts).toEqual([]);
    expect(existsSync(join(runDir, 'scratch/documents'))).toBe(false);
  });
});
