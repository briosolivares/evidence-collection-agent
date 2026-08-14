// Past-run discovery for /runs: read the runs directory and classify each
// run from its artifacts alone. The status semantics follow the core's
// write contract: metrics.json exists only when the loop returned
// normally, and manifest.finishedAt is stamped by runTask's `finally` —
// so "finished without metrics" means stopped (cancelled/failed), NEVER
// "crashed" (design ruling).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Manifest } from '../run/artifacts.js';
import type { RunMetrics } from '../loop/workerSession.js';
import type { ManifestView, MetricsView } from './store/state.js';

/** One row of the /runs list. */
export interface RunListEntry {
  /** Absolute run directory path. */
  runDir: string;
  /** The run id (directory name); ids sort lexically by time. */
  id: string;
  /** Task text from the manifest. */
  task: string;
  /** ISO start time from the manifest. */
  startedAt: string;
  /** ✓ complete (metrics present) · ◐ unfinished (no finishedAt) ·
   * ✗ stopped (finished without metrics). */
  status: 'complete' | 'unfinished' | 'stopped';
}

function readManifest(runDir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Scan a runs directory, newest first. Directories without a readable
 * manifest are skipped (they are not runs).
 */
export function scanRuns(runsBaseDir: string): RunListEntry[] {
  let names: string[];
  try {
    names = readdirSync(runsBaseDir);
  } catch {
    return [];
  }

  const entries: RunListEntry[] = [];
  // Run ids are lexically time-ordered; descending = newest first.
  for (const name of [...names].sort().reverse()) {
    const runDir = join(runsBaseDir, name);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = readManifest(runDir);
    if (manifest === undefined) continue;

    const status: RunListEntry['status'] = existsSync(join(runDir, 'metrics.json'))
      ? 'complete'
      : manifest.finishedAt === undefined
        ? 'unfinished'
        : 'stopped';

    entries.push({
      runDir,
      id: name,
      task: manifest.task,
      startedAt: manifest.startedAt,
      status,
    });
  }
  return entries;
}

/** Load the run-summary view (manifest + metrics) for one run. */
export function loadRunSummary(
  runDir: string,
): { manifest: ManifestView; metrics?: MetricsView } {
  const manifest = readManifest(runDir);
  if (manifest === undefined) {
    throw new Error(`no readable manifest in ${runDir}`);
  }

  const artifacts = manifest.artifacts.map((artifact) => {
    let sizeBytes: number | undefined;
    try {
      sizeBytes = statSync(join(runDir, artifact.filename)).size;
    } catch {
      sizeBytes = undefined;
    }
    return {
      filename: artifact.filename,
      sizeBytes,
      sha256Prefix: artifact.sha256.slice(0, 12),
      ...(artifact.sourceUrl === undefined ? {} : { sourceUrl: artifact.sourceUrl }),
    };
  });

  const manifestView: ManifestView = {
    task: manifest.task,
    startedAt: manifest.startedAt,
    ...(manifest.finishedAt === undefined ? {} : { finishedAt: manifest.finishedAt }),
    artifacts,
  };

  try {
    const metrics = JSON.parse(
      readFileSync(join(runDir, 'metrics.json'), 'utf8'),
    ) as RunMetrics;
    return {
      manifest: manifestView,
      metrics: {
        status: metrics.status,
        turns: metrics.turns,
        totalTokens: metrics.inputTokens + metrics.outputTokens,
        wallClockMs: metrics.wallClockMs,
      },
    };
  } catch {
    return { manifest: manifestView };
  }
}
