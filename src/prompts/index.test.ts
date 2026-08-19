import { describe, expect, it } from 'vitest';

import { contractPrompt, verifierPrompt, workerPrompt } from './index.js';

// Guards the packaged runtime path: every role prompt must load from the
// Markdown files shipped inside src/prompts/, wherever the package runs from.
describe('prompt loading', () => {
  const prompts = {
    workerPrompt,
    contractPrompt,
    verifierPrompt,
  };

  it('loads every role prompt from its Markdown file', () => {
    for (const text of Object.values(prompts)) {
      expect(text.length).toBeGreaterThan(200);
    }
  });

  it('keeps each prompt free of template placeholders', () => {
    for (const text of Object.values(prompts)) {
      expect(text).not.toContain('${');
    }
  });

  it('has no trailing whitespace so the cached prefix stays byte-stable', () => {
    for (const text of Object.values(prompts)) {
      expect(text).toBe(text.trimEnd());
    }
  });

  it('loads the right prompt for each role', () => {
    expect(workerPrompt).toContain("Sherlock's evidence-collection worker");
    expect(contractPrompt).toContain('one immutable output contract');
    expect(verifierPrompt).toContain('fresh, read-only evidence judge');
  });
});
