// Fixture run-directory builders for /runs tests: shape matches the
// core's real artifacts (manifest.json always; metrics.json only for
// normally-completed runs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ArtifactRole } from '../../src/run/artifacts.js';

/** Options describing one fixture run. */
export interface FixtureRun {
  /** Directory name; run ids sort lexically by time. */
  id: string;
  task: string;
  startedAt: string;
  /** Present ⇒ manifest is finalized. */
  finishedAt?: string;
  /** Present ⇒ metrics.json exists (normal loop completion). */
  metrics?: {
    status: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    wallClockMs: number;
  };
  /** Artifact files to create, with manifest entries. Published (artifacts/)
   * entries carry roles; scratch entries none — roles presence is the
   * published/private marker, exactly as writeArtifact records it. */
  artifacts?: {
    filename: string;
    content: string;
    sha256: string;
    sourceUrl?: string;
    roles?: ArtifactRole[];
  }[];
}

/** Create one fixture run directory under baseDir. */
export function writeFixtureRun(baseDir: string, run: FixtureRun): string {
  const runDir = join(baseDir, run.id);
  mkdirSync(runDir, { recursive: true });

  const artifacts = run.artifacts ?? [];
  for (const artifact of artifacts) {
    const filePath = join(runDir, artifact.filename);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, artifact.content);
  }

  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        task: run.task,
        startedAt: run.startedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        artifacts: artifacts.map((artifact) => ({
          filename: artifact.filename,
          sha256: artifact.sha256,
          ...(artifact.sourceUrl === undefined ? {} : { sourceUrl: artifact.sourceUrl }),
          ...(artifact.roles === undefined ? {} : { roles: artifact.roles }),
          capturedAt: run.startedAt,
        })),
      },
      null,
      2,
    ),
  );

  if (run.metrics !== undefined) {
    writeFileSync(join(runDir, 'metrics.json'), JSON.stringify(run.metrics, null, 2));
  }
  return runDir;
}
