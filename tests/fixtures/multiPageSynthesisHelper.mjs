import { readFile, writeFile } from 'node:fs/promises';

const factsUrl = new URL('./synthesis-facts.json', import.meta.url);
const documentUrl = new URL('./synthesis.md', import.meta.url);

async function readFacts() {
  try {
    return JSON.parse(await readFile(factsUrl, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function renderDocument(facts) {
  const lines = ['# Multi-page synthesis', ''];
  for (const fact of facts) {
    lines.push(
      `## ${fact.label}`,
      '',
      `- Title: ${fact.title}`,
      `- Heading: ${fact.heading}`,
      `- URL: ${fact.url}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function capturePage(browser, label) {
  const fact = await browser.js(`({
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    url: location.href
  })`);
  const facts = await readFacts();
  const labeledFact = { label, ...fact };
  facts.push(labeledFact);

  await Promise.all([
    writeFile(factsUrl, `${JSON.stringify(facts, null, 2)}\n`),
    writeFile(documentUrl, renderDocument(facts)),
  ]);
  return labeledFact;
}
