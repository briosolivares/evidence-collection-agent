import { finalizeManifest, initManifest, writeArtifact } from '../../src/run/artifacts.js';
import { createRunDir } from '../../src/run/runDir.js';
import { generateRunId } from '../../src/run/runId.js';
import { appendTranscriptEvent } from '../../src/run/transcript.js';
import type { RunTaskFn } from '../types.js';

/** Run-dir-relative path of the deliverable the fake agent writes —
 * published under artifacts/ like a real deliverable. */
export const FAKE_DELIVERABLE = 'artifacts/answer.md';

/**
 * Make a fake agent satisfying RunTaskFn: each call produces, in
 * milliseconds and without a browser or model, a run directory shaped like
 * a real trial's — finalized manifest, one hashed deliverable
 * (answer.md), and a transcript. Used by harness tests and the demo; the
 * real T14 runTask replaces it at the CLI's single wiring point.
 *
 * @param runsBaseDir - directory to create run directories under; created
 *   if missing
 * @returns a RunTaskFn whose every call yields a fresh run directory
 *   containing a finalized manifest that lists answer.md with a correct
 *   hash
 */
export function makeFakeRunTask(runsBaseDir: string): RunTaskFn {
  return async (taskText, opts) => {
    const runDir = createRunDir(runsBaseDir, generateRunId());
    initManifest(runDir, taskText);
    // A transcript that *claims* success — present precisely so the suite
    // can prove graders are never pointed at it (the standing rule).
    appendTranscriptEvent(runDir, {
      type: 'note',
      text: 'fake agent claims success; graders must never read this file',
    });
    writeArtifact(
      runDir,
      FAKE_DELIVERABLE,
      Buffer.from(`# Answer\n\nTask: ${taskText}\n`),
      {
        roles: ['requested_output'],
        ...(opts.startUrl !== undefined ? { sourceUrl: opts.startUrl } : {}),
      },
    );
    finalizeManifest(runDir);
    return { runDir };
  };
}
