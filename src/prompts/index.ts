import { readFileSync } from 'node:fs';

/**
 * System prompts for the three model roles, loaded from the sibling Markdown
 * files once at module init. Each string is therefore byte-stable for the
 * process lifetime, which the prompt-cache prefix relies on. Task, contract,
 * run, provider, and resume data belong in conversation messages, never here.
 */
function loadPrompt(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url), 'utf8').trimEnd();
}

export const workerPrompt = loadPrompt('worker.md');
export const contractPrompt = loadPrompt('contract.md');
export const verifierPrompt = loadPrompt('verifier.md');
