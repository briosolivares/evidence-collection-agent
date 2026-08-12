import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initManifest, writeArtifact } from '../../../../src/run/artifacts.js';
import type { AssertionResult } from '../../../types.js';
import type { YcW24AiOracle } from '../oracle/ycClient.js';
import { grade } from './grader.js';

const COMPANY_NAMES = ['Atlas Labs', 'Beacon AI', 'Cedar Systems', 'Delta Works', 'Ember Logic'];
const KEYWORDS = ['robotics', 'compliance', 'forecasting', 'dispatching', 'diagnostics'];
const ORACLE: YcW24AiOracle = {
  companies: COMPANY_NAMES.map((name, index) => ({
    name, slug: name.toLowerCase().replace(/ /g, '-'),
    oneLiner: `${KEYWORDS[index]} automation for teams`,
    longDescription: `The company applies ${KEYWORDS[index]} workflows to a difficult industry problem.`,
    tags: ['Artificial Intelligence'],
    founders: [`Alice ${['Archer', 'Baker', 'Cole', 'Diaz', 'Evans'][index]}`, `Bob ${['Able', 'Bell', 'Clark', 'Dunn', 'Earl'][index]}`],
  })),
};
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'yc-outreach-grader-'));
  initManifest(runDir, 'YC outreach grader test');
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
function passingCsv(): string {
  const rows = ORACLE.companies.flatMap((company, index) => company.founders.map((founder) => {
    const slug = founder.toLowerCase().replace(/ /g, '-');
    const first = founder.split(' ')[0];
    const email = `Hi ${first}, I was impressed by ${company.name}'s approach to ${KEYWORDS[index]} workflows for operating teams. I would value your perspective and would love to schedule a 15-minute call next week to learn more. Best, Auditor`;
    return [founder, `https://www.linkedin.com/in/${slug}`, email].map(csvEscape).join(',');
  }));
  return `founder_name,linkedin_url,cold_outreach_email\n${rows.join('\n')}\n`;
}
function byName(results: AssertionResult[], name: string): AssertionResult {
  const found = results.find((result) => result.name === name);
  if (!found) throw new Error(`missing assertion ${name}`);
  return found;
}

describe('yc_w24_outreach grader', () => {
  it('passes all founders from exactly five live-oracle companies', async () => {
    writeArtifact(runDir, 'artifacts/outreach.csv', Buffer.from(passingCsv()), { roles: ['requested_output'] });
    expect((await grade(runDir, ORACLE)).every((result) => result.passed)).toBe(true);
  });

  it('rejects an unknown founder and a missing cofounder', async () => {
    const lines = passingCsv().trim().split('\n');
    lines.splice(2, 1);
    lines[1] = lines[1]!.replace('Alice Archer', 'Unknown Person');
    writeArtifact(runDir, 'artifacts/outreach.csv', Buffer.from(`${lines.join('\n')}\n`), { roles: ['requested_output'] });
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'every founder belongs to an oracle-listed YC W24 AI company').passed).toBe(false);
    expect(byName(results, 'rows represent exactly five companies and include every oracle-listed founder for each').passed).toBe(false);
  });

  it('rejects a company LinkedIn URL and a generic email without the call ask', async () => {
    const bad = passingCsv()
      .replace('https://www.linkedin.com/in/alice-archer', 'https://www.linkedin.com/company/atlas-labs')
      .replace(/"Hi Alice,[^"]+"/, '"Hello there. This is a generic note with no specific request and not enough useful personalization for its intended recipient."');
    writeArtifact(runDir, 'artifacts/outreach.csv', Buffer.from(bad), { roles: ['requested_output'] });
    const results = await grade(runDir, ORACLE);
    expect(byName(results, 'every LinkedIn URL is a distinct plausible personal profile for its founder').passed).toBe(false);
    expect(byName(results, 'every outreach email is founder/company personalized and asks for a 15-minute call').passed).toBe(false);
  });

  it('enforces exact columns, manifests, hashes, and oracle validation', async () => {
    writeArtifact(runDir, 'artifacts/outreach.csv', Buffer.from(passingCsv().replace('cold_outreach_email', 'cold_outreach_email,company')), { roles: ['requested_output'] });
    expect(byName(await grade(runDir, ORACLE), 'CSV has exactly the columns founder_name, linkedin_url, cold_outreach_email (no more, no fewer)').passed).toBe(false);
    writeArtifact(runDir, 'artifacts/outreach.csv', Buffer.from(passingCsv()), { roles: ['requested_output'] });
    writeFileSync(join(runDir, 'artifacts', 'outreach.csv'), `${passingCsv()}tampered`);
    expect(byName(await grade(runDir, ORACLE), 'manifest hashes verify').passed).toBe(false);
    await expect(async () => grade(runDir, { companies: [] })).rejects.toThrow(/oracle/);
  });
});
