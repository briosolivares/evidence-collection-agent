import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDiscoveredUrlIndex,
  recordObservedUrl,
  type DiscoveredUrlIndex,
} from '../../browser/discoveredUrlIndex.js';
import {
  PublicResourceReadError,
  PublicResourceUrlError,
  type PublicResourceReader,
  type ReadResourceOutput,
} from '../../browser/publicResourceReader.js';
import {
  createEvidenceStore,
  type EvidenceRecord,
  type EvidenceStore,
} from '../../evidence/evidenceStore.js';
import { initManifest } from '../../run/artifacts.js';
import type { ToolCtx, ToolDef } from '../registry.js';
import {
  createReadResourceTool,
  READ_RESOURCE_TOOL_NAME,
  readResourceInputSchema,
  type ReadResourceInput,
  type ReadResourceResult,
} from './readResource.js';

const OBSERVED_URL = 'https://data.test/rows.json';

let runDir: string;
let store: EvidenceStore;
let index: DiscoveredUrlIndex;
/** URLs the stub reader was actually asked for. */
let reads: string[];

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'read-resource-test-'));
  initManifest(runDir, 'read the resource');
  store = createEvidenceStore(runDir);
  index = createDiscoveredUrlIndex();
  reads = [];
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function ctx(): ToolCtx {
  return { runDir };
}

/** Build a scripted reader response. */
function output(overrides: Partial<ReadResourceOutput> & { body: string }): ReadResourceOutput {
  const bytes = new TextEncoder().encode(overrides.body);
  const url = overrides.finalUrl ?? overrides.requestedUrl ?? OBSERVED_URL;
  return {
    requestedUrl: overrides.requestedUrl ?? url,
    finalUrl: url,
    status: overrides.status ?? 200,
    headers: overrides.headers ?? {},
    ...(overrides.contentType !== undefined ? { contentType: overrides.contentType } : {}),
    bytes,
    truncated: overrides.truncated ?? false,
    hops: overrides.hops ?? [{ url, status: overrides.status ?? 200, addresses: ['93.184.216.34'] }],
  };
}

/** A reader that answers from a script (or throws) and records its calls. */
function stubReader(
  answer: ReadResourceOutput | Error | ((url: string) => ReadResourceOutput),
): PublicResourceReader {
  return {
    async read(request) {
      reads.push(request.url);
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(request.url) : answer;
    },
  };
}

function tool(
  answer: ReadResourceOutput | Error | ((url: string) => ReadResourceOutput),
  options: { withStore?: boolean; inlineMaxBytes?: number } = {},
): ToolDef<ReadResourceInput> {
  return createReadResourceTool({
    reader: () => stubReader(answer),
    discoveredUrls: () => index,
    ...(options.withStore === false ? {} : { evidenceStore: () => store }),
    ...(options.inlineMaxBytes !== undefined ? { inlineMaxBytes: options.inlineMaxBytes } : {}),
  });
}

async function run(
  definition: ToolDef<ReadResourceInput>,
  input: ReadResourceInput,
): Promise<ReadResourceResult> {
  return (await definition.execute(input, ctx())) as ReadResourceResult;
}

function readRecord(path: string): EvidenceRecord & { detail: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(runDir, path), 'utf8')) as EvidenceRecord & {
    detail: Record<string, unknown>;
  };
}

describe('read_resource contract', () => {
  it('is a named, read-only tool with a strict schema', () => {
    const definition = tool(output({ body: '{}' }));
    expect(definition.name).toBe(READ_RESOURCE_TOOL_NAME);
    expect(definition.readOnly).toBe(true);

    expect(readResourceInputSchema.safeParse({ url: OBSERVED_URL }).success).toBe(true);
    expect(
      readResourceInputSchema.safeParse({ url: OBSERVED_URL, unexpected: 1 }).success,
    ).toBe(false);
    expect(readResourceInputSchema.safeParse({ url: OBSERVED_URL, maxBytes: 0 }).success).toBe(
      false,
    );
    expect(
      readResourceInputSchema.safeParse({ url: OBSERVED_URL, maxBytes: 1.5 }).success,
    ).toBe(false);
    expect(readResourceInputSchema.safeParse({ url: OBSERVED_URL, format: 'yaml' }).success).toBe(
      false,
    );
  });

  it('rejects the factory when the inline budget cannot fit the result envelope', () => {
    for (const invalid of [0, -1, 1.5, 40_000]) {
      expect(() =>
        createReadResourceTool({
          reader: () => stubReader(output({ body: '{}' })),
          discoveredUrls: () => index,
          inlineMaxBytes: invalid,
        }),
      ).toThrow();
    }
  });
});

describe('read_resource provenance gate', () => {
  it('refuses a URL that was never observed, without touching the network', async () => {
    const definition = tool(output({ body: '{"secret":1}' }));
    await expect(run(definition, { url: 'https://invented.test/data.json' })).rejects.toThrow(
      /never observed/,
    );
    expect(reads).toEqual([]);
  });

  it('reads a URL observed as a link, and normalizes it before fetching', async () => {
    recordObservedUrl(index, `${OBSERVED_URL}#section`, 'observed_link');
    const definition = tool(output({ body: '{"rows":[1,2]}', contentType: 'application/json' }));

    const result = await run(definition, { url: OBSERVED_URL });
    // The fetched URL is the normalized one the gate approved, not the raw
    // input.
    expect(reads).toEqual([OBSERVED_URL]);
    expect(result.json).toEqual({ rows: [1, 2] });
    expect(result.format).toBe('json');
  });

  it('reads any path on a deliberately visited origin', async () => {
    recordObservedUrl(index, 'https://data.test/index.html', 'deliberate_navigation');
    const definition = tool(output({ body: '{"ok":true}', contentType: 'application/json' }));

    const result = await run(definition, { url: 'https://data.test/deep/rows.json' });
    expect(result.status).toBe(200);
  });

  it('records the URL that served the body, but nothing found inside it', async () => {
    recordObservedUrl(index, OBSERVED_URL, 'observed_link');
    const definition = tool(
      output({
        body: '<a href="https://elsewhere.test/next.json">next</a>',
        contentType: 'text/html',
        requestedUrl: OBSERVED_URL,
        finalUrl: 'https://data.test/rows.json?v=2',
        hops: [
          { url: OBSERVED_URL, status: 302, addresses: ['93.184.216.34'] },
          { url: 'https://data.test/rows.json?v=2', status: 200, addresses: ['93.184.216.34'] },
        ],
      }),
    );

    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.redirectChain).toEqual([OBSERVED_URL, 'https://data.test/rows.json?v=2']);
    expect(index.observedUrls()).toContain('https://data.test/rows.json?v=2');
    // A link inside a fetched body is reported but NOT authorized: allowing it
    // would turn one read into an unbounded crawl steered by page content.
    expect(result.links).toEqual(['https://elsewhere.test/next.json']);
    expect(index.observedUrls()).not.toContain('https://elsewhere.test/next.json');
  });
});

describe('read_resource parsed views', () => {
  beforeEach(() => {
    recordObservedUrl(index, OBSERVED_URL, 'observed_link');
  });

  it('offloads an over-budget JSON value and keeps its shape inline', async () => {
    const rows = Array.from({ length: 400 }, (_value, position) => ({
      name: `row-${position}`,
      value: position,
    }));
    const definition = tool(
      output({ body: JSON.stringify(rows), contentType: 'application/json' }),
      { inlineMaxBytes: 500 },
    );

    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.json).toBeUndefined();
    expect(result.shape).toBe('400 items with keys name, value');
    expect(result.offloaded?.offloadedTo).toMatch(/read_resource-1\.txt$/);
    expect(existsSync(join(runDir, result.offloaded!.offloadedTo))).toBe(true);
    // The offloaded file holds the complete value, not the preview.
    const offloaded = readFileSync(join(runDir, result.offloaded!.offloadedTo), 'utf8');
    expect(JSON.parse(offloaded)).toHaveLength(400);
  });

  it('bounds a table view and offloads the complete delimited content', async () => {
    const csv = [
      'name,value',
      ...Array.from({ length: 300 }, (_value, position) => `row-${position},${position}`),
    ].join('\n');
    const definition = tool(output({ body: csv, contentType: 'text/csv' }), {
      inlineMaxBytes: 400,
    });

    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.format).toBe('csv');
    expect(result.table?.columns).toEqual(['name', 'value']);
    expect(result.table?.rowCount).toBe(300);
    // Bounded inline, but the count is honest and the rest has a path.
    expect(result.table?.rowsShown).toBeLessThan(300);
    expect(result.table?.rows).toHaveLength(result.table!.rowsShown);
    expect(readFileSync(join(runDir, result.offloaded!.offloadedTo), 'utf8')).toBe(csv);
  });

  it('returns the whole table inline when it fits, with no offload', async () => {
    const definition = tool(output({ body: 'a,b\n1,2\n3,4\n', contentType: 'text/csv' }));
    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.table?.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(result.table?.rowsShown).toBe(2);
    expect(result.offloaded).toBeUndefined();
  });

  it('extracts title, text, and links from HTML', async () => {
    const definition = tool(
      output({
        body: '<title>Filing index</title><body><p>Total: 42</p><a href="/f.csv">csv</a></body>',
        contentType: 'text/html; charset=utf-8',
      }),
    );

    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.format).toBe('html');
    expect(result.title).toBe('Filing index');
    expect(result.text).toContain('Total: 42');
    expect(result.links).toEqual(['https://data.test/f.csv']);
  });

  it('reports a truncated body and a parse fallback instead of failing', async () => {
    const definition = tool(
      output({ body: '{"rows": [1, 2', contentType: 'application/json', truncated: true }),
    );

    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.truncated).toBe(true);
    expect(result.format).toBe('text');
    expect(result.parseWarning).toContain('not valid JSON');
  });

  it('always attaches the spot-check caveat', async () => {
    const definition = tool(output({ body: '{"a":1}', contentType: 'application/json' }));
    const result = await run(definition, { url: OBSERVED_URL });
    expect(result.note).toContain('anonymously');
    expect(result.note).toContain('Spot-check');
  });
});

describe('read_resource evidence', () => {
  beforeEach(() => {
    recordObservedUrl(index, OBSERVED_URL, 'observed_link');
  });

  it('records the original bytes by default and returns a citable id', async () => {
    const definition = tool(output({ body: '{"rows":[1,2]}', contentType: 'application/json' }));
    const result = await run(definition, { url: OBSERVED_URL });

    expect(result.evidenceId).toBe('E1');
    expect(result.evidencePath).toBe('scratch/evidence/E1.json');
    const record = readRecord(result.evidencePath!);
    expect(record.detail.recordType).toBe('network_response');
    expect(record.detail.bodyText).toBe('{"rows":[1,2]}');
    expect(record.summary).toContain('Anonymous json read');
  });

  it('skips evidence only when explicitly asked', async () => {
    const definition = tool(output({ body: 'plain text' }), { withStore: false });
    const result = await run(definition, { url: OBSERVED_URL, captureEvidence: false });
    expect(result.evidenceId).toBeUndefined();
  });

  it('fails closed when evidence is wanted but the run has no ledger', async () => {
    const definition = tool(output({ body: 'plain text' }), { withStore: false });
    await expect(run(definition, { url: OBSERVED_URL })).rejects.toThrow(/no evidence ledger/);
    // Nothing was fetched: the refusal precedes the network call.
    expect(reads).toEqual([]);
  });
});

describe('read_resource error guidance', () => {
  beforeEach(() => {
    recordObservedUrl(index, OBSERVED_URL, 'observed_link');
  });

  it('turns a refused destination into "do not retry" guidance', async () => {
    const definition = tool(
      new PublicResourceUrlError('link_local', OBSERVED_URL, '169.254.169.254 is link-local.'),
    );
    await expect(run(definition, { url: OBSERVED_URL })).rejects.toThrow(/do not retry/);
  });

  it('turns a transport failure into a retry-elsewhere suggestion', async () => {
    const definition = tool(
      new PublicResourceReadError('too_many_redirects', OBSERVED_URL, 'chain too long.'),
    );
    await expect(run(definition, { url: OBSERVED_URL })).rejects.toThrow(/browser page/);
  });
});
