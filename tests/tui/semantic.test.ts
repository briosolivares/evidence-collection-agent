import { describe, expect, it } from 'vitest';

import { deriveSemanticLine } from '../../src/tui/store/semantic.js';

describe('deriveSemanticLine — the live tool table', () => {
  // One row per tool the registry actually offers. A tool missing from this
  // table renders as its bare registry name in the transcript, which is the
  // regression this suite exists to catch — so keep it in step with
  // src/tools/index.ts's TOOL_ORDER.
  const table: Array<{
    name: string;
    input: unknown;
    line: string;
    isEvidence: boolean;
  }> = [
    {
      name: 'set_output_contract',
      input: { outputs: [] },
      line: 'Stating the output contract',
      isEvidence: false,
    },
    {
      name: 'update_table',
      input: { outputId: 'roster', upsert: { rows: [{ rowId: 'r1' }, { rowId: 'r2' }] } },
      line: 'Filling roster: 2 rows',
      isEvidence: false,
    },
    {
      name: 'write_document',
      input: { outputId: 'summary' },
      line: 'Writing summary',
      isEvidence: true,
    },
    { name: 'observe', input: {}, line: 'Reading the page', isEvidence: false },
    {
      name: 'browser_action',
      input: { actions: [{ op: 'navigate', url: 'https://www.sec.gov/cgi-bin/browse-edgar' }] },
      line: 'Opening sec.gov/cgi-bin/browse-edgar',
      isEvidence: false,
    },
    {
      name: 'handle_dialog',
      input: { dialogId: 'd1', action: 'accept' },
      line: 'Answering a dialog (accept)',
      isEvidence: false,
    },
    {
      name: 'execute_javascript',
      input: { code: 'return 1' },
      line: 'Running a page script',
      isEvidence: false,
    },
    {
      name: 'capture_text',
      input: { label: 'member list' },
      line: 'Capturing "member list"',
      isEvidence: true,
    },
    {
      name: 'inspect_document',
      input: { path: 'artifacts/filing.pdf' },
      line: 'Reading artifacts/filing.pdf',
      isEvidence: false,
    },
    {
      name: 'screenshot',
      input: { filename: 'filing-page.png' },
      line: 'Captured filing-page.png',
      isEvidence: true,
    },
    {
      name: 'download',
      input: { ref: 'e9', filename: 'exhibit-99.pdf' },
      line: 'Downloaded exhibit-99.pdf',
      isEvidence: true,
    },
    {
      name: 'grep',
      input: { pattern: 'Series B' },
      line: 'Searching files for "Series B"',
      isEvidence: false,
    },
    {
      name: 'read_file',
      input: { file_path: 'notes.md' },
      line: 'Re-reading notes.md',
      isEvidence: false,
    },
    {
      name: 'write_file',
      input: { file_path: 'top5.csv', content: '…' },
      line: 'Evidence saved → top5.csv',
      isEvidence: true,
    },
    {
      name: 'edit_file',
      input: { file_path: 'scratch/plan.md' },
      line: 'Editing scratch/plan.md',
      isEvidence: false,
    },
    {
      name: 'bash',
      input: { command: 'python3 tally.py' },
      line: 'Running `python3 tally.py`',
      isEvidence: false,
    },
    {
      name: 'ask_user_question',
      input: { questions: [] },
      line: 'Asking you a question',
      isEvidence: false,
    },
    {
      name: 'submit_for_verification',
      input: {},
      line: 'Submitting for verification',
      isEvidence: false,
    },
  ];

  for (const row of table) {
    it(`maps ${row.name} to "${row.line}"`, () => {
      expect(deriveSemanticLine(row.name, row.input)).toEqual({
        line: row.line,
        isEvidence: row.isEvidence,
      });
    });
  }

  it('hints exactly the publishing tools as likely evidence', () => {
    const evidence = table.filter((row) => row.isEvidence).map((row) => row.name);
    expect(evidence.sort()).toEqual([
      'capture_text',
      'download',
      'screenshot',
      'write_document',
      'write_file',
    ]);
  });

  it('styles a scratch write as plain activity, never as evidence-to-be', () => {
    expect(deriveSemanticLine('write_file', { file_path: 'scratch/plan.md' })).toEqual({
      line: 'Writing scratch/plan.md',
      isEvidence: false,
    });
  });
});

describe('deriveSemanticLine — action sequences, truncation, and malformed input', () => {
  it('names a sequence by its first op and counts the rest', () => {
    expect(
      deriveSemanticLine('browser_action', {
        actions: [
          { op: 'fill', target: 'e3', text: 'quarterly report' },
          { op: 'click', target: 'e1' },
        ],
      }),
    ).toEqual({ line: 'Typing "quarterly report" (+1)', isEvidence: false });
    expect(deriveSemanticLine('browser_action', { actions: [{ op: 'scroll' }] })).toEqual({
      line: 'Scrolling',
      isEvidence: false,
    });
  });

  it('names every op browserActionSchema declares', () => {
    // These are exactly the ops in browserActionSchema. The 'fill' case is why
    // this test exists: the implementation originally checked for a 'type' op
    // that the schema never had, and the old test asserted the same wrong name,
    // so a real gap passed. Anything falling through to "Running N browser
    // steps" here means an op has no line.
    const lines: Record<string, string> = {
      navigate: 'Opening example.com',
      click: 'Clicking e1',
      fill: 'Typing "hi"',
      press: 'Pressing Enter',
      select: 'Choosing an option',
      check: 'Toggling a checkbox',
      hover: 'Hovering e1',
      upload: 'Attaching a file',
      scroll: 'Scrolling',
    };
    const inputs: Record<string, unknown> = {
      navigate: { op: 'navigate', url: 'https://example.com/' },
      click: { op: 'click', target: 'e1' },
      fill: { op: 'fill', target: 'e1', text: 'hi' },
      press: { op: 'press', key: 'Enter' },
      select: { op: 'select', target: 'e1', values: ['a'] },
      check: { op: 'check', target: 'e1', checked: true },
      hover: { op: 'hover', target: 'e1' },
      upload: { op: 'upload', target: 'e1', runPath: 'scratch/x.pdf' },
      scroll: { op: 'scroll', direction: 'down', amount: 'page' },
    };
    for (const [op, expected] of Object.entries(lines)) {
      expect(deriveSemanticLine('browser_action', { actions: [inputs[op]] }).line, op).toBe(
        expected,
      );
    }
  });

  it('summarizes a sequence whose first op it does not recognize', () => {
    expect(
      deriveSemanticLine('browser_action', { actions: [{ op: 'future_op' }, { op: 'click' }] }),
    ).toEqual({ line: 'Running 2 browser steps', isEvidence: false });
  });

  it('distinguishes the three update_table sections', () => {
    expect(deriveSemanticLine('update_table', { outputId: 'roster', delete: { rowIds: ['r1'] } }).line).toBe(
      'Removing rows from roster',
    );
    expect(
      deriveSemanticLine('update_table', {
        outputId: 'roster',
        completeness: { method: 'header states 12' },
      }).line,
    ).toBe('Proving roster is complete');
    // Upsert wins when a call carries several: filling rows is the headline.
    expect(
      deriveSemanticLine('update_table', {
        outputId: 'roster',
        upsert: { rows: [{ rowId: 'r1' }] },
        completeness: { method: 'header states 12' },
      }).line,
    ).toBe('Filling roster: 1 row');
  });

  it('truncates long typed text', () => {
    const { line } = deriveSemanticLine('browser_action', {
      actions: [{ op: 'fill', target: 'e1', text: 'x'.repeat(100) }],
    });
    expect(line).toBe(`Typing "${'x'.repeat(39)}…"`);
  });

  it('shortens long navigate URLs with host preserved', () => {
    const { line } = deriveSemanticLine('browser_action', {
      actions: [{ op: 'navigate', url: `https://www.sec.gov/${'segment/'.repeat(20)}` }],
    });
    expect(line.startsWith('Opening sec.gov/segment/')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('handles unparseable URLs by truncating the raw string', () => {
    const { line } = deriveSemanticLine('browser_action', {
      actions: [{ op: 'navigate', url: 'not a real url' }],
    });
    expect(line).toBe('Opening not a real url');
  });

  it('degrades gracefully with missing or malformed input', () => {
    expect(deriveSemanticLine('browser_action')).toEqual({
      line: 'Acting on the page',
      isEvidence: false,
    });
    expect(deriveSemanticLine('write_file', null)).toEqual({
      line: 'Saving evidence',
      isEvidence: true,
    });
    expect(deriveSemanticLine('update_table', 42).line).toBe('Updating a table');
    expect(deriveSemanticLine('grep', 42).line).toBe('Searching files');
    expect(deriveSemanticLine('bash', {}).line).toBe('Running a command');
  });

  it('falls back to the bare name for unknown tools', () => {
    expect(deriveSemanticLine('future_tool', {})).toEqual({
      line: 'future_tool',
      isEvidence: false,
    });
  });

  it('truncates long file paths in evidence lines', () => {
    const { line } = deriveSemanticLine('write_file', {
      file_path: `deep/${'nested/'.repeat(20)}evidence.csv`,
    });
    expect(line.startsWith('Evidence saved → deep/nested/')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });
});
