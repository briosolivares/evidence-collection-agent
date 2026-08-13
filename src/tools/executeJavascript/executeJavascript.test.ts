import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BrowserJavaScriptTimeoutError,
  DEFAULT_JAVASCRIPT_TIMEOUT_MS,
  MAX_JAVASCRIPT_TIMEOUT_MS,
  type BrowserJavaScriptResult,
  type JavaScriptCapablePage,
} from '../../browser/browserJavaScript.js';
import { createEvidenceStore, type EvidenceRecord } from '../../evidence/evidenceStore.js';
import { initManifest, MANIFEST_FILENAME, type Manifest } from '../../run/artifacts.js';
import { PREVIEW_MAX_BYTES } from '../capResult.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, type ToolCtx, type ToolDef } from '../registry.js';
import {
  createExecuteJavascriptTool,
  earlyExecuteJavaScriptInputSchema,
  EXECUTE_JAVASCRIPT_TOOL_NAME,
  type ExecuteJavascriptDeps,
  type ExecuteJavascriptResult,
} from './executeJavascript.js';

/**
 * A fake page implementing the tool's narrow seam — no Chrome, no network.
 * Every branch of the tool is reachable through these two methods, which is
 * exactly why the seam exists.
 */
interface FakePage {
  page: JavaScriptCapablePage;
  /** Every evaluation the tool asked for, in order. */
  calls: Array<{ code: string; timeoutMs: number }>;
  /** How many times the tool discarded and replaced the page. */
  replacements: () => number;
}

interface FakePageOptions {
  value?: unknown;
  url?: string;
  documentToken?: string;
  logs?: string[];
  /** Rejection from evaluateJson, e.g. a timeout or a page-thrown error. */
  evaluateRejectsWith?: Error;
  /** Rejection from replaceUnresponsivePage — the session-is-gone case. */
  replaceRejectsWith?: Error;
}

function fakePage(options: FakePageOptions = {}): FakePage {
  const calls: Array<{ code: string; timeoutMs: number }> = [];
  let replacements = 0;

  const page: JavaScriptCapablePage = {
    async evaluateJson(code, timeoutMs): Promise<BrowserJavaScriptResult> {
      calls.push({ code, timeoutMs });
      if (options.evaluateRejectsWith !== undefined) throw options.evaluateRejectsWith;
      return {
        value: 'value' in options ? options.value : null,
        url: options.url ?? 'https://example.test/list',
        documentToken: options.documentToken ?? 'doc-token-1',
        logs: options.logs ?? [],
      };
    },
    async replaceUnresponsivePage(): Promise<void> {
      replacements += 1;
      if (options.replaceRejectsWith !== undefined) throw options.replaceRejectsWith;
    },
  };

  return { page, calls, replacements: () => replacements };
}

// A temp dir stands in for the run directory; the suite stays hermetic.
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'execute-js-tool-test-'));
  initManifest(runDir, 'extract the list');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

/** A deterministic 125ms-per-tick clock, so recorded timings are assertable. */
function fakeClock(): () => number {
  let elapsed = 0;
  return () => (elapsed += 125);
}

function buildTool(
  deps: Partial<ExecuteJavascriptDeps> & Pick<ExecuteJavascriptDeps, 'page'>,
): ToolDef {
  return createExecuteJavascriptTool({
    policy: 'allow',
    now: fakeClock(),
    ...deps,
  }) as unknown as ToolDef;
}

function callTool(tool: ToolDef, input: unknown, ctx: ToolCtx = { runDir }) {
  return executeToolCall(
    createRegistry([tool]),
    { id: 'js-call-1', name: EXECUTE_JAVASCRIPT_TOOL_NAME, input },
    ctx,
  );
}

function parseResult(content: string): ExecuteJavascriptResult {
  return JSON.parse(content) as ExecuteJavascriptResult;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8')) as Manifest;
}

/** The extraction this tool exists for: one call, every row of a repeated
 * structure, instead of one observation per row. */
const BULK_CODE =
  '[...document.querySelectorAll("#companies tr")].map((row) => ({' +
  ' name: row.cells[0].innerText.trim(), batch: row.cells[1].innerText.trim(),' +
  ' href: row.querySelector("a")?.href ?? null }))';

function bulkRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `Company ${index + 1}`,
    batch: 'W24',
    href: `https://example.test/companies/${index + 1}`,
  }));
}

describe('execute_javascript tool', () => {
  it('bulk-extracts a repeated list in one call and persists a citable evidence record', async () => {
    const rows = bulkRows(25);
    const { page, calls } = fakePage({
      value: rows,
      url: 'https://example.test/companies',
      documentToken: 'doc-token-7',
    });
    const store = createEvidenceStore(runDir);
    const tool = buildTool({ page: () => page, evidenceStore: () => store });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: BULK_CODE,
      captureEvidence: true,
    });

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    // One call, twenty-five rows, inline.
    expect(calls).toEqual([{ code: BULK_CODE, timeoutMs: DEFAULT_JAVASCRIPT_TIMEOUT_MS }]);
    expect(parsed.value).toEqual(rows);
    expect(parsed).not.toHaveProperty('offloadedValue');
    expect(parsed.url).toBe('https://example.test/companies');
    expect(parsed.documentToken).toBe('doc-token-7');
    expect(parsed.durationMs).toBe(125);
    expect(parsed).not.toHaveProperty('logs');

    // The evidence id is citable, and the record behind it exists.
    expect(parsed.evidenceId).toBe('E1');
    expect(parsed.evidencePath).toBe('scratch/evidence/E1.json');
    const recordPath = join(runDir, parsed.evidencePath!);
    expect(existsSync(recordPath)).toBe(true);

    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as EvidenceRecord;
    expect(record.kind).toBe('javascript_extraction');
    expect(record.summary).toContain('25 items with keys name, batch, href');
    expect(record.sourceUrl).toBe('https://example.test/companies');
    expect(record.detail).toEqual({
      target: 'selected_top_document',
      code: BULK_CODE,
      url: 'https://example.test/companies',
      documentToken: 'doc-token-7',
      timeoutMs: DEFAULT_JAVASCRIPT_TIMEOUT_MS,
      durationMs: 125,
      logs: [],
      value: rows,
    });

    // ...and its bytes are hashed into the manifest, with no roles (private).
    const entry = readManifest().artifacts.find((a) => a.filename === parsed.evidencePath);
    expect(entry?.sha256).toBe(store.get('E1')!.sha256);
    expect(entry).not.toHaveProperty('roles');
  });

  it('records timing and the document token even without evidence capture', async () => {
    const { page } = fakePage({ value: { total: 42 }, logs: ['ready', 'parsed 42'] });
    const tool = buildTool({ page: () => page });

    const parsed = parseResult(
      (await callTool(tool, { target: 'selected_top_document', code: 'x' })).content,
    );

    expect(parsed.value).toEqual({ total: 42 });
    expect(parsed.logs).toEqual(['ready', 'parsed 42']);
    expect(parsed).not.toHaveProperty('evidenceId');
  });

  it('fails a non-JSON return with a bounded, useful error naming the offender', async () => {
    // A huge sibling value proves the message is bounded by construction: it
    // names a path and a type, never the value.
    const { page } = fakePage({
      value: {
        blob: 'x'.repeat(60_000),
        rows: [{ name: 'ok' }, { name: 'bad', when: new Date('2026-08-13T00:00:00Z') }],
      },
    });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'window.rows',
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('value.rows[1].when is a Date instance');
    expect(result.content).toContain('dates to ISO strings');
    expect(result.content).not.toContain('xxxxx');
    expect(result.content.length).toBeLessThan(800);
  });

  it.each([
    ['a nested undefined', { rows: [{ name: undefined }] }, 'value.rows[0].name is undefined'],
    ['a non-finite number', { count: Number.NaN }, 'value.count is NaN'],
    ['a returned DOM-ish class instance', { el: new Map() }, 'value.el is a Map instance'],
    ['nothing at all', undefined, 'value is undefined'],
  ])('rejects %s from the page', async (_name, value, expected) => {
    const { page } = fakePage({ value });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, { target: 'selected_top_document', code: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(expected);
  });

  it('terminates a timeout, replaces the page, and says the refs are gone', async () => {
    const { page, replacements } = fakePage({
      evaluateRejectsWith: new BrowserJavaScriptTimeoutError(2_500),
    });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'while (true) {}',
      timeoutMs: 2_500,
    });

    expect(result.isError).toBe(true);
    expect(replacements()).toBe(1);
    expect(result.content).toContain('exceeded its 2500ms limit and was terminated');
    expect(result.content).toContain('closed and replaced');
    expect(result.content).toContain('every ref and observation');
    expect(result.content).toContain(`max ${MAX_JAVASCRIPT_TIMEOUT_MS}`);
  });

  it('reports an unusable session when even the replacement page fails', async () => {
    const { page, replacements } = fakePage({
      evaluateRejectsWith: new BrowserJavaScriptTimeoutError(2_500),
      replaceRejectsWith: new Error('Target page, context or browser has been closed'),
    });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'while (true) {}',
      timeoutMs: 2_500,
    });

    expect(result.isError).toBe(true);
    expect(replacements()).toBe(1);
    expect(result.content).toContain('Replacing the unresponsive page also failed');
    expect(result.content).toContain('no longer usable');
  });

  it('bounds a page-thrown error instead of pasting a whole stack', async () => {
    const { page, replacements } = fakePage({
      evaluateRejectsWith: new Error(`TypeError: cannot read x\n${'stack line\n'.repeat(500)}`),
    });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, { target: 'selected_top_document', code: 'x.y' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Page JavaScript failed: TypeError: cannot read x');
    expect(result.content).toContain('[truncated]');
    // A page error is not a timeout: the page stays exactly as it was.
    expect(replacements()).toBe(0);
    expect(result.content.length).toBeLessThan(1_200);
  });

  it('offloads a large value with stable preview bytes, keeping the evidence id inline', async () => {
    const rows = bulkRows(400);
    const { page } = fakePage({ value: rows });
    const store = createEvidenceStore(runDir);
    const tool = buildTool({
      page: () => page,
      evidenceStore: () => store,
      valueMaxBytes: 4_000,
    });
    const input = {
      target: 'selected_top_document',
      code: BULK_CODE,
      captureEvidence: true,
    };

    const first = parseResult((await callTool(tool, input)).content);
    const second = parseResult((await callTool(tool, input)).content);

    // The value moved to a file; the citable id and timing did not.
    expect(first).not.toHaveProperty('value');
    expect(first.evidenceId).toBe('E1');
    const offloaded = first.offloadedValue!;
    expect(offloaded.offloadedTo).toBe(
      `scratch/tool-output/${EXECUTE_JAVASCRIPT_TOOL_NAME}-1.txt`,
    );
    expect(offloaded.note).toContain('over the 4000-byte inline limit');
    expect(offloaded.note).toContain(offloaded.offloadedTo);

    // The complete value is on disk, hashed, and is real JSON again.
    const full = readFileSync(join(runDir, offloaded.offloadedTo), 'utf8');
    expect(JSON.parse(full)).toEqual(rows);
    expect(full.startsWith(offloaded.preview)).toBe(true);
    expect(
      readManifest().artifacts.some((a) => a.filename === offloaded.offloadedTo),
    ).toBe(true);

    // Stable preview bytes: the same value previews identically, cut on a
    // whole-line boundary and inside the preview budget.
    expect(second.offloadedValue!.preview).toBe(offloaded.preview);
    expect(second.offloadedValue!.offloadedTo).toBe(
      `scratch/tool-output/${EXECUTE_JAVASCRIPT_TOOL_NAME}-2.txt`,
    );
    expect(Buffer.byteLength(offloaded.preview, 'utf8')).toBeLessThanOrEqual(
      PREVIEW_MAX_BYTES,
    );
    // Cut exactly on a line boundary: the next byte in the file is the
    // newline the preview stopped at, so no preview ever ends mid-line.
    expect(offloaded.preview.endsWith('\n')).toBe(false);
    expect(full[offloaded.preview.length]).toBe('\n');
  });

  it('bounds console output and the executed URL, while the evidence record keeps everything', async () => {
    const logs = Array.from({ length: 15 }, (_unused, index) => `log ${index + 1}`);
    logs[0] = 'L'.repeat(5_000);
    const longUrl = `data:text/html,${'a'.repeat(3_000)}`;
    const { page } = fakePage({ value: { ok: true }, logs, url: longUrl });
    const store = createEvidenceStore(runDir);
    const tool = buildTool({ page: () => page, evidenceStore: () => store });

    const parsed = parseResult(
      (
        await callTool(tool, {
          target: 'selected_top_document',
          code: 'x',
          captureEvidence: true,
        })
      ).content,
    );

    expect(parsed.logs).toHaveLength(13);
    expect(parsed.logs!.at(-1)).toBe('... 3 more console lines omitted');
    expect(parsed.logs![0]).toContain('[truncated]');
    expect(parsed.logs![0]!.length).toBeLessThan(500);
    expect(parsed.url.endsWith('... [truncated]')).toBe(true);

    // The record is the complete copy — that is the whole point of recording.
    const record = store.get(parsed.evidenceId!)!;
    const detail = record.detail as { url: string; logs: string[] };
    expect(detail.url).toBe(longUrl);
    expect(detail.logs).toHaveLength(15);
    expect(detail.logs[0]).toHaveLength(5_000);
    // ...but the one-line summary stays a one-line summary.
    expect(record.summary.length).toBeLessThan(300);
    expect(record.summary).toContain('[truncated]');
  });

  it("prevents execution entirely under policy 'deny'", async () => {
    const { page, calls } = fakePage({ value: [1, 2, 3] });
    let pageResolved = 0;
    const decisions: string[] = [];
    const tool = createExecuteJavascriptTool({
      page: () => {
        pageResolved += 1;
        return page;
      },
      policy: 'deny',
      onPolicyDecision: (line) => decisions.push(line),
    }) as unknown as ToolDef;

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'document.title',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('javascriptPolicy=deny');
    expect(result.content).toContain('Do not retry');
    // Denied before the page is touched at all — not by inspecting the code.
    expect(calls).toEqual([]);
    expect(pageResolved).toBe(0);
    expect(decisions).toEqual([
      'javascriptPolicy=deny (anonymous session): execute_javascript will refuse every call.',
    ]);
  });

  it('fails at configuration time when an authenticated session has no explicit policy', () => {
    const { page } = fakePage();

    expect(() =>
      createExecuteJavascriptTool({ page: () => page, authenticatedSession: true }),
    ).toThrow(/must set javascriptPolicy explicitly/);

    // Anonymous sessions still work out of the box.
    expect(() => createExecuteJavascriptTool({ page: () => page })).not.toThrow();
  });

  it("logs an authenticated 'allow' as accepted capability exposure, not as a sandbox", () => {
    const { page } = fakePage();
    const decisions: string[] = [];

    createExecuteJavascriptTool({
      page: () => page,
      policy: 'allow',
      authenticatedSession: true,
      onPolicyDecision: (line) => decisions.push(line),
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('authenticated session');
    expect(decisions[0]).toContain('accepted capability exposure');
    expect(decisions[0]).toContain('This is not a sandbox.');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['zero', 0],
    ['fractional', 1.5],
    ['over the ceiling', MAX_JAVASCRIPT_TIMEOUT_MS + 1],
  ])('rejects a %s timeoutMs before touching the page', async (_name, timeoutMs) => {
    const { page, calls } = fakePage({ value: [] });
    const tool = buildTool({ page: () => page });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'x',
      timeoutMs,
    });

    expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(result.content).toContain('at timeoutMs');
    expect(calls).toEqual([]);
  });

  it('passes a valid timeoutMs straight through to the page', async () => {
    const { page, calls } = fakePage({ value: [] });
    const tool = buildTool({ page: () => page });

    await callTool(tool, {
      target: 'selected_top_document',
      code: 'x',
      timeoutMs: MAX_JAVASCRIPT_TIMEOUT_MS,
    });

    expect(calls).toEqual([{ code: 'x', timeoutMs: MAX_JAVASCRIPT_TIMEOUT_MS }]);
  });

  it('fails a captureEvidence call in a run with no evidence ledger', async () => {
    const { page, calls } = fakePage({ value: [1] });
    const tool = buildTool({ page: () => page, evidenceStore: () => undefined });

    const result = await callTool(tool, {
      target: 'selected_top_document',
      code: 'x',
      captureEvidence: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('no evidence ledger');
    // Nothing ran: a page that may have been mutated with no way to record it
    // is worse than a refused call.
    expect(calls).toEqual([]);
  });

  it('rejects a target other than the one early literal, and unknown fields', async () => {
    const { page } = fakePage({ value: [] });
    const tool = buildTool({ page: () => page });

    const wrongTarget = await callTool(tool, { target: 'frame', code: 'x' });
    const extraField = await callTool(tool, {
      target: 'selected_top_document',
      code: 'x',
      frameId: 'f1',
    });
    const blankCode = await callTool(tool, { target: 'selected_top_document', code: '' });

    expect(wrongTarget).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(wrongTarget.content).toContain('selected_top_document');
    expect(extraField).toMatchObject({ isError: true, errorKind: 'invalid_input' });
    expect(blankCode).toMatchObject({ isError: true, errorKind: 'invalid_input' });
  });

  it('is declared a page write, never read-only', () => {
    const { page } = fakePage();
    const tool = createExecuteJavascriptTool({ page: () => page, policy: 'allow' });

    expect(tool.name).toBe('execute_javascript');
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toContain('page WRITE');
    expect(tool.description).toContain('not a sandbox');
    expect(tool.requiresUserInteraction).toBeUndefined();
  });

  it('refuses a value budget that would let a result carrying an evidence id be offloaded whole', () => {
    const { page } = fakePage();

    expect(() =>
      createExecuteJavascriptTool({ page: () => page, policy: 'allow', valueMaxBytes: 49_000 }),
    ).toThrow(/leaves no room for the result envelope/);
    expect(() =>
      createExecuteJavascriptTool({ page: () => page, policy: 'allow', valueMaxBytes: 0 }),
    ).toThrow(/positive integer/);
  });

  it('exposes the early input schema for the API tool definition', () => {
    expect(
      earlyExecuteJavaScriptInputSchema.safeParse({
        target: 'selected_top_document',
        code: 'document.title',
      }).success,
    ).toBe(true);
  });
});
