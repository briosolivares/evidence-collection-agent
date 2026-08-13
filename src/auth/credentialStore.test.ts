import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileCredentialStore } from './credentialStore.js';

describe('FileCredentialStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'credential-store-'));
    filePath = join(dir, '.credentials.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function write(entries: unknown, mode = 0o600): Promise<void> {
    await writeFile(filePath, JSON.stringify(entries), { mode });
    // writeFile's mode only applies at creation; force it for overwrites.
    await chmod(filePath, mode);
  }

  it('returns the exact-hostname entry', async () => {
    await write({ 'x.com': { username: 'user-a', password: 'pass-a' } });
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('x.com')).resolves.toEqual({
      username: 'user-a',
      password: 'pass-a',
    });
  });

  it('suffix-matches subdomains on label boundaries only', async () => {
    await write({ 'x.com': { username: 'user-a', password: 'pass-a' } });
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('mobile.x.com')).resolves.toEqual({
      username: 'user-a',
      password: 'pass-a',
    });
    // "notx.com" ends with "x.com" as a string but is a different site.
    await expect(store.lookup('notx.com')).resolves.toBeNull();
  });

  it('prefers the longest matching key', async () => {
    await write({
      'x.com': { username: 'broad', password: 'broad-pass' },
      'mobile.x.com': { username: 'narrow', password: 'narrow-pass' },
    });
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('login.mobile.x.com')).resolves.toMatchObject({
      username: 'narrow',
    });
    // Exact match beats every suffix candidate.
    await expect(store.lookup('mobile.x.com')).resolves.toMatchObject({
      username: 'narrow',
    });
    await expect(store.lookup('x.com')).resolves.toMatchObject({
      username: 'broad',
    });
  });

  it('matches hostnames case-insensitively', async () => {
    await write({ 'X.com': { username: 'user-a', password: 'pass-a' } });
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('x.COM')).resolves.toMatchObject({
      username: 'user-a',
    });
  });

  it('treats a missing file as an empty store', async () => {
    const store = new FileCredentialStore(join(dir, 'does-not-exist.json'));

    await expect(store.lookup('x.com')).resolves.toBeNull();
    await expect(store.listHosts()).resolves.toEqual([]);
  });

  it('re-reads the file on every lookup', async () => {
    await write({ 'x.com': { username: 'before', password: 'pass-1' } });
    const store = new FileCredentialStore(filePath);
    await expect(store.lookup('x.com')).resolves.toMatchObject({
      username: 'before',
    });

    await write({ 'x.com': { username: 'after', password: 'pass-2' } });

    await expect(store.lookup('x.com')).resolves.toMatchObject({
      username: 'after',
    });
  });

  it('ignores extra entry keys like notes', async () => {
    await write({
      'x.com': { username: 'user-a', password: 'pass-a', notes: 'test account' },
    });
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('x.com')).resolves.toEqual({
      username: 'user-a',
      password: 'pass-a',
    });
  });

  it('lists hostnames without touching secret material', async () => {
    await write({
      'x.com': { username: 'user-a', password: 'pass-a' },
      'example.org': { username: 'user-b', password: 'pass-b' },
    });
    const store = new FileCredentialStore(filePath);

    await expect(store.listHosts()).resolves.toEqual(['x.com', 'example.org']);
  });

  it('reports invalid JSON with the path and never the contents', async () => {
    const canary = 'leaked-secret-canary-3f9a';
    await writeFile(filePath, `{"x.com": {"password": "${canary}"`, {
      mode: 0o600,
    });
    const store = new FileCredentialStore(filePath);

    const thrown = await store.lookup('x.com').catch((error: Error) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(filePath);
    expect((thrown as Error).message).not.toContain(canary);
  });

  it('reports an invalid entry shape with host and path only', async () => {
    const canary = 'leaked-secret-canary-71bd';
    await write({
      'x.com': { username: 'user-a', password: 1234, other: canary },
    });
    const store = new FileCredentialStore(filePath);

    const thrown = await store.lookup('x.com').catch((error: Error) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(filePath);
    expect((thrown as Error).message).toContain('"x.com"');
    expect((thrown as Error).message).not.toContain(canary);
  });

  it('rejects a non-object top level with a path-only error', async () => {
    await write(['not', 'an', 'object']);
    const store = new FileCredentialStore(filePath);

    await expect(store.lookup('x.com')).rejects.toThrow(filePath);
  });

  it('warns once on stderr when the file is readable by others', async () => {
    await write({ 'x.com': { username: 'user-a', password: 'pass-a' } }, 0o644);
    const store = new FileCredentialStore(filePath);

    await store.lookup('x.com');
    await store.lookup('x.com');

    const errorSpy = vi.mocked(console.error);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('chmod 600');
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain('pass-a');
  });

  it('does not warn for owner-only permissions', async () => {
    await write({ 'x.com': { username: 'user-a', password: 'pass-a' } }, 0o600);
    const store = new FileCredentialStore(filePath);

    await store.lookup('x.com');

    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });
});
