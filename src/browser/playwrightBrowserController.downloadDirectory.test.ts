import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pinProfileDownloadDirectory } from './playwrightBrowserController.js';

/**
 * Chrome, not Playwright, decides where a download it handles itself lands,
 * and it reads `download.default_directory` from the profile's Preferences at
 * startup. Left unset it resolves to the OS Downloads folder, which is how the
 * suite came to deposit a file per run into the real ~/Downloads. These tests
 * pin the seeding contract directly: no Chrome launch, no timing dependence.
 */

const profileDirs: string[] = [];

function makeProfileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'download-pin-profile-'));
  profileDirs.push(dir);
  return dir;
}

function readPreferences(profileDir: string): Record<string, unknown> {
  const raw = readFileSync(join(profileDir, 'Default', 'Preferences'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of profileDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pinProfileDownloadDirectory', () => {
  it('points Chrome at a downloads directory inside the profile', () => {
    const profileDir = makeProfileDir();

    pinProfileDownloadDirectory(profileDir);

    expect(readPreferences(profileDir).download).toEqual({
      default_directory: join(profileDir, 'downloads'),
      prompt_for_download: false,
    });
  });

  it('creates the download directory, so Chrome has somewhere to write', () => {
    const profileDir = makeProfileDir();

    pinProfileDownloadDirectory(profileDir);

    expect(statSync(join(profileDir, 'downloads')).isDirectory()).toBe(true);
  });

  it('merges into an existing profile rather than replacing it', () => {
    // The real profile is a logged-in one: replacing its Preferences would
    // discard the session this codebase's login helper exists to establish.
    const profileDir = makeProfileDir();
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(
      join(profileDir, 'Default', 'Preferences'),
      JSON.stringify({
        profile: { name: 'a logged-in profile' },
        download: { directory_upgrade: true, extensions_to_open: '' },
      }),
    );

    pinProfileDownloadDirectory(profileDir);

    const preferences = readPreferences(profileDir);
    expect(preferences.profile).toEqual({ name: 'a logged-in profile' });
    expect(preferences.download).toEqual({
      directory_upgrade: true,
      extensions_to_open: '',
      default_directory: join(profileDir, 'downloads'),
      prompt_for_download: false,
    });
  });

  it('overwrites a download directory the profile already pinned elsewhere', () => {
    const profileDir = makeProfileDir();
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    writeFileSync(
      join(profileDir, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: '/Users/someone/Downloads' } }),
    );

    pinProfileDownloadDirectory(profileDir);

    expect(readPreferences(profileDir)).toHaveProperty(
      'download.default_directory',
      join(profileDir, 'downloads'),
    );
  });

  it('leaves an unparseable Preferences file alone instead of failing the launch', () => {
    // Best-effort by design: a preferences file this cannot read must not stop
    // a session from starting.
    const profileDir = makeProfileDir();
    mkdirSync(join(profileDir, 'Default'), { recursive: true });
    const prefsPath = join(profileDir, 'Default', 'Preferences');
    writeFileSync(prefsPath, '{ not json');

    expect(() => pinProfileDownloadDirectory(profileDir)).not.toThrow();
    expect(readFileSync(prefsPath, 'utf8')).toBe('{ not json');
  });

  it('does not throw when the profile directory cannot be written', () => {
    expect(() => pinProfileDownloadDirectory('/dev/null/not-a-directory')).not.toThrow();
  });
});
