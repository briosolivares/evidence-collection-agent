// The Step 4 acceptance sweep: grep one real run's artifacts for every
// password in the credentials file, and for the Browserbase credentials a
// remote run must never record — its API key, and any CDP connect URL, which
// is a full session-control capability. Complements the permanent vitest
// sweep (fixture credentials) by checking a live run's recorded output.
// Prints file paths and needle LABELS only — never secret material.
//
// Usage: node scripts/sweepRunForSecrets.mjs <runDir> [credentialsFile]
// Exits 1 if any run file contains any stored password or Browserbase credential.

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

// Browserbase credentials, when this run used the remote provider. The API key
// is a needle only if it is in this environment; the CDP connect endpoint is
// swept for unconditionally, since its host is fixed and a run's artifacts must
// never carry a session-control URL whether or not a key is present here.
const browserbaseNeedles = [
  ...(typeof process.env.BROWSERBASE_API_KEY === 'string' &&
  process.env.BROWSERBASE_API_KEY.trim() !== ''
    ? [{ label: 'BROWSERBASE_API_KEY', value: process.env.BROWSERBASE_API_KEY }]
    : []),
  { label: 'Browserbase CDP connect URL', value: 'connect.browserbase.com' },
];

const files = readdirSync(runDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

const passwordLeaks = [];
/** Browserbase leaks by needle label, so the report names WHAT leaked without
 * ever printing the value. */
const browserbaseLeaks = new Map();

for (const file of files) {
  const contents = readFileSync(file, 'latin1');
  if (passwords.some((password) => contents.includes(password))) {
    passwordLeaks.push(file);
  }
  for (const needle of browserbaseNeedles) {
    if (!contents.includes(needle.value)) continue;
    const seen = browserbaseLeaks.get(needle.label) ?? [];
    seen.push(file);
    browserbaseLeaks.set(needle.label, seen);
  }
}

console.log(
  `swept ${files.length} files in ${runDir} for ${passwords.length} stored password(s) ` +
    `and ${browserbaseNeedles.length} Browserbase needle(s)`,
);
let failed = false;
if (passwordLeaks.length > 0) {
  failed = true;
  console.error(`LEAK: stored password found in:\n  ${passwordLeaks.join('\n  ')}`);
}
for (const [label, leakedFiles] of browserbaseLeaks) {
  failed = true;
  console.error(`LEAK: ${label} found in:\n  ${leakedFiles.join('\n  ')}`);
}
if (failed) process.exit(1);
console.log('clean: no stored password and no Browserbase credential appears in any run file');
