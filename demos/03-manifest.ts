// Demo for T3: write two artifacts, print the manifest, and verify a
// recorded hash against `shasum -a 256`.
// Run with: npx tsx demos/03-manifest.ts

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { finalizeManifest, initManifest, MANIFEST_FILENAME, writeArtifact } from '../src/run/artifacts.js';
import { generateRunId } from '../src/run/runId.js';
import { createRunDir } from '../src/run/runDir.js';

const runDir = createRunDir('runs', generateRunId());
console.log(`created run dir: ${runDir}`);

initManifest(runDir, 'demo: exercise the manifest');

const csvEntry = writeArtifact(
  runDir,
  'stories.csv',
  Buffer.from('title,url,points\nExample story,https://example.com,42\n'),
  { sourceUrl: 'https://news.ycombinator.com' },
);
writeArtifact(runDir, 'notes/answer.md', Buffer.from('# Answer\n\nCollected 1 story.\n'));

finalizeManifest(runDir);

const manifestPath = join(runDir, MANIFEST_FILENAME);
console.log(`\n$ cat ${manifestPath}`);
process.stdout.write(readFileSync(manifestPath, 'utf8'));

// Independently verify the recorded hash with the system shasum tool.
const csvPath = join(runDir, csvEntry.filename);
const shasumOutput = execFileSync('shasum', ['-a', '256', csvPath], { encoding: 'utf8' });
const externalHash = shasumOutput.split(/\s+/)[0];

console.log(`\nmanifest sha256:  ${csvEntry.sha256}`);
console.log(`shasum -a 256:    ${externalHash}`);
console.log(externalHash === csvEntry.sha256 ? 'hashes match' : 'HASH MISMATCH');
