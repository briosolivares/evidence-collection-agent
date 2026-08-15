import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ArtifactMeta, ManifestEntry } from '../../src/run/artifacts.js';
import { commitArtifactWriteTransaction } from '../../src/run/artifactWriteTransaction.js';

type Boundary = 'after_journal' | 'after_temp' | 'after_artifact';

const [boundaryValue, runDir, filename, payloadPath, metaValue] = process.argv.slice(2);
if (
  !isBoundary(boundaryValue) ||
  runDir === undefined ||
  filename === undefined ||
  payloadPath === undefined ||
  metaValue === undefined
) {
  throw new Error(
    'usage: artifactWriteCrashChild <after_journal|after_temp|after_artifact> ' +
      '<runDir> <filename> <payloadPath> <meta-json>',
  );
}

const bytes = readFileSync(payloadPath);
const meta = JSON.parse(metaValue) as ArtifactMeta;
const entry: ManifestEntry = {
  filename,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ...(meta.sourceUrl === undefined ? {} : { sourceUrl: meta.sourceUrl }),
  ...(meta.roles === undefined ? {} : { roles: meta.roles }),
  capturedAt: new Date().toISOString(),
  ...(meta.completionStatus === undefined
    ? {}
    : { completionStatus: meta.completionStatus }),
};

commitArtifactWriteTransaction(runDir, entry, bytes, {
  ...(boundaryValue === 'after_journal'
    ? { afterJournalPersisted: killNow }
    : {}),
  ...(boundaryValue === 'after_temp'
    ? { afterArtifactTempFileSync: killNow }
    : {}),
  ...(boundaryValue === 'after_artifact'
    ? { afterArtifactCommitted: killNow }
    : {}),
});

throw new Error(`artifact crash fixture passed ${boundaryValue} without being killed`);

function killNow(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL unexpectedly returned');
}

function isBoundary(value: string | undefined): value is Boundary {
  return value === 'after_journal' || value === 'after_temp' || value === 'after_artifact';
}
