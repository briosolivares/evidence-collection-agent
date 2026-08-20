import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Packing and cold-starting the full source package can slow down while the
// browser-heavy suite is running in parallel.
vi.setConfig({ testTimeout: 120_000 });

describe('installed package', () => {
  it('starts without shipping or resolving the development eval harness', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'sherlock-package-'));
    try {
      const packResult = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--pack-destination', temporaryRoot], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }),
      ) as Array<{ filename: string }>;
      const tarball = join(temporaryRoot, packResult[0]!.filename);
      const contents = execFileSync('tar', ['-tzf', tarball], {
        encoding: 'utf8',
      });

      expect(contents).not.toMatch(/^package\/evals\//m);
      expect(contents).not.toContain('package/src/tui/developmentEvals.ts');
      expect(contents).not.toContain('package/src/tui/bridge/evalRuntime.ts');
      expect(contents).not.toContain('package/src/tui/bridge/evalSession.ts');

      execFileSync('tar', ['-xzf', tarball, '-C', temporaryRoot]);
      const installedPackage = join(temporaryRoot, 'package');
      // Exercise the exact tarball graph without downloading a second copy
      // of dependencies during the test.
      symlinkSync(join(repositoryRoot, 'node_modules'), join(installedPackage, 'node_modules'));
      const temporaryHome = join(temporaryRoot, 'home');
      mkdirSync(temporaryHome);

      const launched = spawnSync(process.execPath, [join(installedPackage, 'bin/sherlock.mjs')], {
        cwd: temporaryRoot,
        env: { ...process.env, HOME: temporaryHome },
        encoding: 'utf8',
        timeout: 90_000,
      });

      expect(launched.status).not.toBe(0);
      expect(launched.stderr.trim()).toMatch(/interactive terminal|TTY/i);
      expect(launched.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/i);

      // The non-TTY preflight above runs before JSX is evaluated. Simulate the
      // small part of a terminal Ink needs, launch the demo, and require the
      // welcome card to render. This catches a packaged tsx loader silently
      // falling back from react-jsx to the classic `React.createElement` mode.
      const installedLauncher = join(installedPackage, 'bin/sherlock.mjs');
      const terminalSmokeSource = [
        "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
        "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
        'process.stdin.setRawMode = () => process.stdin;',
        "process.argv.push('--demo');",
        // Full-suite CPU contention can make the tsx import take well over
        // five seconds. Keep the child alive long enough to render once.
        'setTimeout(() => process.exit(0), 20_000);',
        `await import(${JSON.stringify(pathToFileURL(installedLauncher).href)});`,
      ].join('\n');
      const terminalLaunch = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', terminalSmokeSource],
        {
          cwd: temporaryRoot,
          env: { ...process.env, HOME: temporaryHome, TERM: 'dumb' },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );

      expect(terminalLaunch.status).toBe(0);
      expect(terminalLaunch.stderr).not.toMatch(
        /React is not defined|ERR_MODULE_NOT_FOUND|Cannot find module/i,
      );
      expect(terminalLaunch.stdout).toMatch(/Sherlock|Welcome back/i);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
