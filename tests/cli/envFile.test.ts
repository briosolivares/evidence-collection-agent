import { mkdtemp, rm, readFile, chmod } from 'node:fs/promises';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setEnvFileValue } from '../../src/cli/envFile.js';

// A real temp directory, not a mocked fs: the whole point of this suite is
// that setEnvFileValue's assumptions about how writeFileSync/chmodSync behave
// hold against the actual filesystem, and a mock would have agreed with a
// buggy implementation just as readily as a correct one.
describe('setEnvFileValue', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-agent-envfile-test-'));
    path = join(dir, '.env');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a missing file with the assignment, owner-only (0o600)', () => {
    setEnvFileValue(path, 'FOO', 'bar');
    expect(readFileSync(path, 'utf8')).toBe('FOO=bar\n');
    // It holds credentials, so it must never be created world- or group-readable.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('appends to an existing file, preserving every other line byte-for-byte, ending without a trailing newline originally', () => {
    const original = '# a comment\nBAR=baz';
    writeFileSync(path, original);
    setEnvFileValue(path, 'FOO', 'bar');
    expect(readFileSync(path, 'utf8')).toBe('# a comment\nBAR=baz\nFOO=bar\n');
  });

  it('appends to an existing file that already ends with a trailing newline, producing exactly one', () => {
    const original = '# a comment\nBAR=baz\n';
    writeFileSync(path, original);
    setEnvFileValue(path, 'FOO', 'bar');
    expect(readFileSync(path, 'utf8')).toBe('# a comment\nBAR=baz\nFOO=bar\n');
  });

  it('rewrites an existing assignment in place, leaving surrounding lines untouched and appending no duplicate', () => {
    const original = '# header\nFOO=old\nBAR=baz\n';
    writeFileSync(path, original);
    setEnvFileValue(path, 'FOO', 'new');
    const updated = readFileSync(path, 'utf8');
    expect(updated).toBe('# header\nFOO=new\nBAR=baz\n');
    expect(updated.match(/^FOO=/gm)).toHaveLength(1);
  });

  it('recognizes an `export FOO=bar` line as a match and rewrites that line rather than appending a shadowed duplicate', () => {
    writeFileSync(path, 'export FOO=old\nBAR=baz\n');
    setEnvFileValue(path, 'FOO', 'new');
    const updated = readFileSync(path, 'utf8');
    // The matched line is replaced with the bare assignment (the form this
    // function always writes); what matters here is that it is a REWRITE of
    // the `export` line in place, not a second line appended below it.
    expect(updated).toBe('FOO=new\nBAR=baz\n');
    expect(updated.match(/FOO=/g)).toHaveLength(1);
  });

  it('recognizes a leading-whitespace `  FOO=bar` line as a match and rewrites that line rather than appending a shadowed duplicate', () => {
    writeFileSync(path, '  FOO=old\nBAR=baz\n');
    setEnvFileValue(path, 'FOO', 'new');
    const updated = readFileSync(path, 'utf8');
    expect(updated).toBe('FOO=new\nBAR=baz\n');
    expect(updated.match(/FOO=/g)).toHaveLength(1);
  });

  it('rewrites the LAST assignment when a key is set more than once, since that is the one process.loadEnvFile would use', () => {
    writeFileSync(path, 'FOO=first\nBAR=baz\nFOO=second\n');
    setEnvFileValue(path, 'FOO', 'new');
    expect(readFileSync(path, 'utf8')).toBe('FOO=first\nBAR=baz\nFOO=new\n');
  });

  it('preserves a non-default mode across a rewrite', async () => {
    writeFileSync(path, 'FOO=old\n');
    await chmod(path, 0o640);
    setEnvFileValue(path, 'FOO', 'new');
    expect(readFileSync(path, 'utf8')).toBe('FOO=new\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('rejects a value containing a newline with a TypeError and leaves the file unchanged on disk', async () => {
    const original = 'FOO=old\nBAR=baz\n';
    writeFileSync(path, original);
    expect(() => setEnvFileValue(path, 'FOO', 'a\nb')).toThrow(TypeError);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('rejects a multi-line value even for a file that does not exist yet, without creating one', () => {
    expect(() => setEnvFileValue(path, 'FOO', 'a\nb')).toThrow(TypeError);
    expect(() => statSync(path)).toThrow();
  });

  it('matches a key containing regex metacharacters literally, not as a pattern', () => {
    // If the key were interpolated into the RegExp unescaped, "A.B" would also
    // match a line like "AxB=", and "." would be a wildcard rather than a dot.
    writeFileSync(path, 'A.B=old\nAxB=unrelated\n');
    setEnvFileValue(path, 'A.B', 'new');
    expect(readFileSync(path, 'utf8')).toBe('A.B=new\nAxB=unrelated\n');
  });
});
