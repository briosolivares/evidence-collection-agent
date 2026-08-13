// The Step 4 acceptance sweep: grep one real run's artifacts for every
// password in the credentials file. Complements the permanent vitest
// sweep (fixture credentials) by checking a live login run's recorded
// output. Prints file paths only — never secret material.
//
// Usage: node scripts/sweepRunForSecrets.mjs <runDir> [credentialsFile]
// Exits 1 if any run file contains any stored password.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , runDirArg, credentialsArg] = process.argv;
if (runDirArg === undefined) {
  console.error('Usage: node scripts/sweepRunForSecrets.mjs <runDir> [credentialsFile]');
  process.exit(2);
}
const runDir = resolve(runDirArg);
const credentialsFile = resolve(credentialsArg ?? '.credentials.json');

const entries = JSON.parse(readFileSync(credentialsFile, 'utf8'));
const passwords = Object.values(entries)
  .map((entry) => entry.password)
  .filter((password) => typeof password === 'string' && password !== '');
if (passwords.length === 0) {
  console.error(`No passwords found in ${credentialsFile}; nothing to sweep.`);
  process.exit(2);
}

const files = readdirSync(runDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

const leaks = files.filter((file) => {
  const contents = readFileSync(file, 'latin1');
  return passwords.some((password) => contents.includes(password));
});

console.log(`swept ${files.length} files in ${runDir}`);
if (leaks.length > 0) {
  console.error(`LEAK: stored password found in:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log('clean: no stored password appears in any run file');
