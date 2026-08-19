import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BrowserController } from '../browser/controller.js';
import {
  initManifest,
  readManifest,
  verifyManifestFiles,
} from '../run/artifacts.js';
import { executeToolCall } from './pipeline.js';
import { createRegistry } from './registry.js';
import { editFileTool, readFileTool, writeFileTool } from './fileTools.js';
import { publishArtifactTool } from './publishArtifact/publishArtifact.js';

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sherlock-v3-tool-surface-'));
  initManifest(runDir, 'publish every generic v3 artifact mode');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const registry = createRegistry([
  publishArtifactTool,
  readFileTool,
  writeFileTool,
  editFileTool,
]);

async function call(
  name: 'publish_artifact' | 'read_file' | 'write_file' | 'edit_file',
  input: unknown,
  browser?: BrowserController,
): Promise<string> {
  const result = await executeToolCall(
    registry,
    { id: `call-${name}`, name, input },
    { runDir, ...(browser === undefined ? {} : { browser }) },
  );
  if (result.isError) throw new Error(result.content);
  return result.content;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('v3 generic artifact surface', () => {
  it('publishes CSV, Markdown, screenshot, and download bytes with verified provenance', async () => {
    const csv = 'name,value\nalpha,1\nbeta,2\n';
    const markdown = '# Findings\n\nTwo rows were collected.\n';
    const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]);
    const download = Buffer.from([0, 255, 3, 4, 5, 0]);
    const browser = {
      currentUrl: () => 'https://source.example.test/report',
      screenshot: async () => screenshot,
      download: async () => ({
        finalUrl: 'https://source.example.test/export.bin',
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        bytes: download,
      }),
    } as unknown as BrowserController;

    await call('write_file', {
      file_path: 'scratch/workspace/rows.csv',
      content: csv,
    });
    await call('publish_artifact', {
      kind: 'file',
      artifact_path: 'artifacts/rows.csv',
      roles: ['requested_output'],
      source_path: 'scratch/workspace/rows.csv',
      source_url: 'https://source.example.test/table',
    });
    await call('publish_artifact', {
      kind: 'text',
      artifact_path: 'artifacts/findings.md',
      roles: ['requested_output'],
      content: markdown,
    });
    await call(
      'publish_artifact',
      {
        kind: 'screenshot',
        artifact_path: 'artifacts/report.png',
        roles: ['evidence'],
      },
      browser,
    );
    await call(
      'publish_artifact',
      {
        kind: 'download',
        artifact_path: 'artifacts/export.bin',
        roles: ['evidence', 'requested_output'],
        url: 'https://source.example.test/export.bin',
      },
      browser,
    );

    const expected = new Map<string, { bytes: Buffer; roles?: string[]; sourceUrl?: string }>([
      [
        'scratch/workspace/rows.csv',
        { bytes: Buffer.from(csv) },
      ],
      [
        'artifacts/rows.csv',
        {
          bytes: Buffer.from(csv),
          roles: ['requested_output'],
          sourceUrl: 'https://source.example.test/table',
        },
      ],
      [
        'artifacts/findings.md',
        { bytes: Buffer.from(markdown), roles: ['requested_output'] },
      ],
      [
        'artifacts/report.png',
        {
          bytes: screenshot,
          roles: ['evidence'],
          sourceUrl: 'https://source.example.test/report',
        },
      ],
      [
        'artifacts/export.bin',
        {
          bytes: download,
          roles: ['requested_output', 'evidence'],
          sourceUrl: 'https://source.example.test/export.bin',
        },
      ],
    ]);

    const manifest = readManifest(runDir);
    expect(manifest.artifacts).toHaveLength(expected.size);
    for (const entry of manifest.artifacts) {
      const wanted = expected.get(entry.filename);
      expect(wanted, entry.filename).toBeDefined();
      expect(readFileSync(join(runDir, entry.filename))).toEqual(wanted!.bytes);
      expect(entry.sha256).toBe(hash(wanted!.bytes));
      expect(entry.roles).toEqual(wanted!.roles);
      expect(entry.sourceUrl).toBe(wanted!.sourceUrl);
    }

    expect(() => verifyManifestFiles(runDir)).not.toThrow();
  });
});
