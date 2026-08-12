import { configDefaults, defineConfig } from 'vitest/config';

// Keep vitest out of linked git worktrees under .claude/ — without this,
// a checked-out worktree makes the suite run every test twice (once per
// checkout), doubling wall-clock time and producing duplicate, load-flaky
// failures for the same test.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
