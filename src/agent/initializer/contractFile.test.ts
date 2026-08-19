import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract } from './outputContract.js';
import {
  V3_OUTPUT_CONTRACT_PATH,
  ensureV3OutputContractFile,
  readV3OutputContractFile,
} from './contractFile.js';

let runDir: string;

const CONTRACT: OutputContract = {
  outputs: [
    {
      id: 'report',
      kind: 'table',
      filename: 'report.csv',
      format: 'csv',
      columns: [{ name: 'name', required: true, type: 'string' }],
      rules: [],
    },
  ],
};

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-contract-file-'));
  mkdirSync(join(runDir, 'harness'), { mode: 0o700 });
  chmodSync(join(runDir, 'harness'), 0o700);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('v3 immutable output contract file', () => {
  it('creates an owner-only canonical file and reads it back', () => {
    ensureV3OutputContractFile(runDir, CONTRACT);

    expect(readV3OutputContractFile(runDir)).toEqual(CONTRACT);
    expect(statSync(join(runDir, V3_OUTPUT_CONTRACT_PATH)).mode & 0o777).toBe(
      0o600,
    );
  });

  it('is idempotent for the same contract and refuses a revision', () => {
    ensureV3OutputContractFile(runDir, CONTRACT);
    const path = join(runDir, V3_OUTPUT_CONTRACT_PATH);
    const before = readFileSync(path, 'utf8');

    expect(() => ensureV3OutputContractFile(runDir, CONTRACT)).not.toThrow();
    expect(() =>
      ensureV3OutputContractFile(runDir, {
        ...CONTRACT,
        assumptions: ['different requirements'],
      }),
    ).toThrow(/refusing to revise/i);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('fails loudly instead of repairing a corrupt existing file', () => {
    writeFileSync(join(runDir, V3_OUTPUT_CONTRACT_PATH), '{broken', {
      mode: 0o600,
    });

    expect(() => ensureV3OutputContractFile(runDir, CONTRACT)).toThrow(
      /not valid JSON/i,
    );
  });
});
