import { describe, expect, it } from 'vitest';

import { deriveSemanticLine } from '../../src/tui/store/semantic.js';

describe('deriveSemanticLine — the fourteen-tool table', () => {
  const table: Array<{
    name: string;
    input: unknown;
    line: string;
    isEvidence: boolean;
  }> = [
    {
      name: 'navigate',
      input: { url: 'https://www.sec.gov/cgi-bin/browse-edgar' },
      line: 'Opening sec.gov/cgi-bin/browse-edgar',
      isEvidence: false,
    },
    { name: 'inspect_page', input: {}, line: 'Reading the page', isEvidence: false },
    { name: 'click', input: { ref: 'e42' }, line: 'Clicking e42', isEvidence: false },
    {
      name: 'type',
      input: { ref: 'e3', text: 'quarterly report 10-Q' },
      line: 'Typing "quarterly report 10-Q"',
      isEvidence: false,
    },
    { name: 'scroll', input: {}, line: 'Scrolling', isEvidence: false },
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
      name: 'write_file',
      input: { file_path: 'top5.csv', content: '…' },
      line: 'Evidence saved → top5.csv',
      isEvidence: true,
    },
    {
      name: 'TaskCreate',
      input: { subject: 'Collect filing evidence', description: 'Find the filing' },
      line: 'Adding a checklist item',
      isEvidence: false,
    },
    { name: 'TaskList', input: {}, line: 'Reviewing the checklist', isEvidence: false },
    {
      name: 'TaskGet',
      input: { taskId: '2' },
      line: 'Reviewing task #2',
      isEvidence: false,
    },
    {
      name: 'TaskUpdate',
      input: { taskId: '2', status: 'in_progress' },
      line: 'Updating task #2',
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

  it('classifies exactly the three evidence producers as evidence', () => {
    const evidence = table.filter((row) => row.isEvidence).map((row) => row.name);
    expect(evidence.sort()).toEqual(['download', 'screenshot', 'write_file']);
  });
});

describe('deriveSemanticLine — truncation and URL edge cases', () => {
  it('summarizes browser batches and highlights nested evidence work', () => {
    expect(
      deriveSemanticLine('browser_batch', {
        actions: [
          { tool: 'click', input: { ref: 'e1' } },
          { tool: 'screenshot', input: { filename: 'proof.png' } },
        ],
      }),
    ).toEqual({ line: 'Running 2 browser steps', isEvidence: true });
    expect(deriveSemanticLine('browser_batch')).toEqual({
      line: 'Running browser steps',
      isEvidence: false,
    });
  });

  it('truncates long typed text', () => {
    const { line } = deriveSemanticLine('type', { ref: 'e1', text: 'x'.repeat(100) });
    expect(line).toBe(`Typing "${'x'.repeat(39)}…"`);
  });

  it('shortens long navigate URLs with host preserved', () => {
    const { line } = deriveSemanticLine('navigate', {
      url: `https://www.sec.gov/${'segment/'.repeat(20)}`,
    });
    expect(line.startsWith('Opening sec.gov/segment/')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('handles unparseable URLs by truncating the raw string', () => {
    const { line } = deriveSemanticLine('navigate', { url: 'not a real url' });
    expect(line).toBe('Opening not a real url');
  });

  it('degrades gracefully with missing or malformed input', () => {
    expect(deriveSemanticLine('navigate')).toEqual({
      line: 'Opening a page',
      isEvidence: false,
    });
    expect(deriveSemanticLine('write_file', null)).toEqual({
      line: 'Saving evidence',
      isEvidence: true,
    });
    expect(deriveSemanticLine('type', { ref: 'e1' }).line).toBe('Typing');
    expect(deriveSemanticLine('grep', 42).line).toBe('Searching files');
    expect(deriveSemanticLine('TaskCreate', null)).toEqual({
      line: 'Adding a checklist item',
      isEvidence: false,
    });
    expect(deriveSemanticLine('TaskList', null)).toEqual({
      line: 'Reviewing the checklist',
      isEvidence: false,
    });
    expect(deriveSemanticLine('TaskGet', null)).toEqual({
      line: 'Reviewing a task',
      isEvidence: false,
    });
    expect(deriveSemanticLine('TaskUpdate', null)).toEqual({
      line: 'Updating a task',
      isEvidence: false,
    });
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
