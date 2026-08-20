#!/usr/bin/env node
// Sherlock launcher: checks the Node floor first (before tsx or any of
// the TUI graph loads — Ink 7 crashes uninformatively on older Node),
// then registers tsx's ESM loader (a runtime dependency — there is no
// build step) and hands off to the TUI entry point. Kept as plain .mjs
// so `npm install -g` / `npm link` can run it with a stock Node.
import { fileURLToPath } from 'node:url';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  console.error(
    `sherlock requires Node 22 or newer (Ink 7); this is Node ${process.versions.node}.`,
  );
  process.exit(1);
}

const { register } = await import('tsx/esm/api');
// Programmatic tsx registration searches for tsconfig from the caller's cwd.
// A global install lives elsewhere, so pass the package's config explicitly;
// otherwise JSX falls back to the classic transform and expects a global
// `React` variable that the react-jsx source intentionally does not import.
register({
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
});
await import(new URL('../src/tui/main.tsx', import.meta.url).href);
