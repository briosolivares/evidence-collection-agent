import { configDefaults, defineConfig } from 'vitest/config';

// Keep vitest out of linked git worktrees under .claude/ — without this,
// a checked-out worktree makes the suite run every test twice (once per
// checkout), doubling wall-clock time and producing duplicate, load-flaky
// failures for the same test.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Ink colorizes whenever the shell reports color support, while every
    // assertion under tests/tui/ matches plain strings — so the same tree
    // passed in a pipe and failed 51 tests in a colored terminal, reading
    // like a rendering regression rather than an environment difference.
    // Pin the suite to uncolored output so it does not depend on who runs
    // it or whether a TTY is attached.
    env: { FORCE_COLOR: '0' },
  },
});
