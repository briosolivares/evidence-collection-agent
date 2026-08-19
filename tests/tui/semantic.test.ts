import { describe, expect, it } from 'vitest';

import { deriveSemanticLine } from '../../src/tui/store/semantic.js';
import { V3_TOOL_ORDER } from '../../src/tools/index.js';

describe('deriveSemanticLine', () => {
  const tools = [
    {
      name: 'browser_execute',
      input: { code: 'return await browser.pageInfo()' },
      line: 'Running a browser program',
      isEvidence: false,
    },
    {
      name: 'publish_artifact',
      input: {
        kind: 'screenshot',
        artifact_path: 'artifacts/source-page.png',
        roles: ['evidence'],
      },
      line: 'Publishing a screenshot → artifacts/source-page.png',
      isEvidence: true,
    },
    {
      name: 'read_file',
      input: { file_path: 'scratch/workspace/notes.md' },
      line: 'Reading scratch/workspace/notes.md',
      isEvidence: false,
    },
    {
      name: 'write_file',
      input: { file_path: 'scratch/workspace/report.md', content: 'draft' },
      line: 'Writing scratch/workspace/report.md',
      isEvidence: false,
    },
    {
      name: 'edit_file',
      input: {
        file_path: 'scratch/workspace/report.md',
        old_string: 'draft',
        new_string: 'final',
      },
      line: 'Editing scratch/workspace/report.md',
      isEvidence: false,
    },
    {
      name: 'bash',
      input: { command: 'rg evidence notes.md' },
      line: 'Running `rg evidence notes.md`',
      isEvidence: false,
    },
    {
      name: 'ask_user',
      input: { question: 'Which account should I use?' },
      line: 'Asking you a question',
      isEvidence: false,
    },
    {
      name: 'finish',
      input: { summary: 'Done' },
      line: 'Submitting for verification',
      isEvidence: false,
    },
  ] as const;

  it('covers the frozen production tool order exactly', () => {
    expect(tools.map((tool) => tool.name)).toEqual(V3_TOOL_ORDER);
  });

  for (const tool of tools) {
    it(`maps ${tool.name} to semantic activity`, () => {
      expect(deriveSemanticLine(tool.name, tool.input)).toEqual({
        line: tool.line,
        isEvidence: tool.isEvidence,
      });
    });
  }

  it('describes every publication mode without exposing inline content', () => {
    for (const [kind, activity] of [
      ['file', 'Publishing an artifact'],
      ['text', 'Publishing an artifact'],
      ['screenshot', 'Publishing a screenshot'],
      ['download', 'Publishing a download'],
    ] as const) {
      const line = deriveSemanticLine('publish_artifact', {
        kind,
        artifact_path: `artifacts/${kind}`,
        content: 'private inline content',
        roles: ['evidence'],
      }).line;
      expect(line).toBe(`${activity} → artifacts/${kind}`);
      expect(line).not.toContain('private inline content');
    }
  });

  it('handles missing input, truncation, and unknown future tools', () => {
    expect(deriveSemanticLine('write_file')).toEqual({
      line: 'Writing a private file',
      isEvidence: false,
    });
    expect(
      deriveSemanticLine('bash', { command: 'x'.repeat(100) }).line,
    ).toBe(`Running \`${'x'.repeat(39)}…\``);
    expect(deriveSemanticLine('future_tool')).toEqual({
      line: 'future_tool',
      isEvidence: false,
    });
  });
});
