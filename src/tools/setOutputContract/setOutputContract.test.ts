import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OutputContract } from '../../contracts/outputContract.js';
import {
  contractRevisionPath,
  createOutputContractStore,
} from '../../contracts/outputContractStore.js';
import { initManifest } from '../../run/artifacts.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry, toApiToolDefs, type ToolCtx, type ToolDef } from '../registry.js';
import { setOutputContractTool } from './setOutputContract.js';

// Driven through executeToolCall — the same pipeline production uses — so
// schema validation, error shaping, and result normalization are exercised
// exactly as the model would experience them.

const registry = createRegistry([setOutputContractTool as ToolDef]);

function contract(filename = 'roster.csv'): OutputContract {
  return {
    outputs: [
      {
        id: 'roster',
        kind: 'table',
        filename,
        format: 'csv',
        columns: [{ name: 'name', required: true, type: 'string' }],
        rules: [],
      },
    ],
  } as OutputContract;
}

let runDir: string;
let ctx: ToolCtx;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'set-contract-test-'));
  initManifest(runDir, 'Publish the roster.');
  ctx = { runDir, outputContracts: createOutputContractStore(runDir) };
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

async function call(input: unknown, overrides: Partial<ToolCtx> = {}) {
  return executeToolCall(
    registry,
    { id: 'call_1', name: 'set_output_contract', input },
    { ...ctx, ...overrides },
  );
}

describe('set_output_contract', () => {
  it('stores revision 1 and echoes the output ids back', async () => {
    const result = await call({ contract: contract() });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content) as {
      revision: number;
      storedAt: string;
      outputIds: string[];
    };
    expect(payload).toEqual({
      revision: 1,
      storedAt: contractRevisionPath(1),
      outputIds: ['roster'],
    });
    expect(existsSync(join(runDir, contractRevisionPath(1)))).toBe(true);
    expect(ctx.outputContracts?.hasContract()).toBe(true);
  });

  it('reports every contract defect in one error and stores nothing', async () => {
    const result = await call({
      contract: {
        outputs: [
          {
            id: 'a',
            kind: 'table',
            filename: 'sub/one.csv',
            format: 'csv',
            columns: [
              { name: 'x', required: true, type: 'string' },
              { name: 'x', required: false, type: 'string' },
            ],
            rules: [],
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    // Both the unsafe path and the duplicate column are named together.
    expect(result.content).toMatch(/sub\/one\.csv/);
    expect(result.content).toMatch(/"x"|'x'|\bx\b/);
    expect(result.content).toMatch(/NOT stored/);
    expect(existsSync(join(runDir, contractRevisionPath(1)))).toBe(false);
    expect(ctx.outputContracts?.hasContract()).toBe(false);
  });

  it('rejects malformed input at the schema boundary before touching the store', async () => {
    const result = await call({ contract: { outputs: 'not an array' } });
    expect(result.isError).toBe(true);
    expect(ctx.outputContracts?.hasContract()).toBe(false);
  });

  it('requires a revision basis on the second call', async () => {
    await call({ contract: contract() });

    const noBasis = await call({ contract: contract('members.csv') });
    expect(noBasis.isError).toBe(true);
    expect(ctx.outputContracts?.contractHistory()).toHaveLength(1);

    const withBasis = await call({
      contract: contract('members.csv'),
      revisionBasis: {
        kind: 'evidence_discovery',
        summary: 'The site publishes members.csv, not roster.csv.',
        evidenceIds: ['E1'],
      },
    });
    expect(withBasis.isError).toBe(false);
    expect(JSON.parse(withBasis.content)).toMatchObject({ revision: 2 });
    // History is append-only: revision 1's file survives.
    expect(existsSync(join(runDir, contractRevisionPath(1)))).toBe(true);
    expect(existsSync(join(runDir, contractRevisionPath(2)))).toBe(true);
  });

  it('fails closed when the run has no contract store', async () => {
    const result = await call({ contract: contract() }, { outputContracts: undefined });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no output-contract store/);
  });

  it('is not read-only: the scheduler must serialize it against other contract reads/writes', () => {
    expect(setOutputContractTool.getAccess({ contract: contract() })).toEqual({
      reads: [],
      writes: ['contract'],
    });
  });

  it('exposes a deterministic API schema the model can be shown', () => {
    const [def] = toApiToolDefs(registry);
    expect(def?.name).toBe('set_output_contract');
    // Serializing twice must be byte-identical — the prompt prefix depends
    // on it for cache stability.
    expect(JSON.stringify(toApiToolDefs(registry))).toBe(JSON.stringify(toApiToolDefs(registry)));
    expect(JSON.stringify(def?.input_schema)).toContain('outputs');
  });
});
